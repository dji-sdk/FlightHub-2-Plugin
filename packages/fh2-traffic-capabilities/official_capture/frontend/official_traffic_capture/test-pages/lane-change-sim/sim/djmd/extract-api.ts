// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * sim dev server 中间件：上传 DJI 机载 MP4 → ffmpeg 抽取 djmd 数据轨 →
 * 解析为 SEI NDJSON 返回。仅本地调试用，不进入插件正式构建。
 *
 * 请求体为原始 MP4 字节（fetch body: File）；成功返回 text/plain NDJSON，
 * 失败返回 JSON { error }。
 */
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RequestHandler } from '@rsbuild/core'
import { SIM_EXTRACT_ENDPOINT } from './endpoint'
import { parseDjmd } from './parser'
import { buildDjmdReplayNdjson } from './to-replay'

export { SIM_EXTRACT_ENDPOINT }

const UPLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 120000

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCommand (cmd: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = []
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`${cmd} 执行超时`))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr })
    })
  })
}

interface FfprobeVideoInfo {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationMs: number;
  readonly nbFrames: number;
  readonly hasDataTrack: boolean;
}

async function probeVideo (filePath: string): Promise<FfprobeVideoInfo> {
  const result = await runCommand('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    filePath,
  ])
  if (result.code !== 0) throw new Error(`ffprobe 失败: ${result.stderr.slice(0, 400)}`)

  const data = JSON.parse(result.stdout) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      nb_frames?: string;
    }>;
    format?: { duration?: string };
  }
  const streams = data.streams ?? []
  const videoStream = streams.find(stream => stream.codec_type === 'video' && stream.width)
  if (!videoStream || !videoStream.width || !videoStream.height) {
    throw new Error('无法读取视频流分辨率')
  }
  const rateParts = (videoStream.r_frame_rate ?? '0/1').split('/')
  const rateDen = Number(rateParts[1] ?? 1)
  const fps = Number(rateParts[0] ?? 0) / (Number.isFinite(rateDen) && rateDen !== 0 ? rateDen : 1)
  if (!(fps > 0)) throw new Error('无法读取视频帧率')

  const durationSec = Number(data.format?.duration ?? 0)
  const durationMs = Number.isFinite(durationSec) && durationSec > 0
    ? durationSec * 1000
    : 1000
  const nbFrames = Number(videoStream.nb_frames ?? 0)

  return {
    width: videoStream.width,
    height: videoStream.height,
    fps,
    durationMs,
    nbFrames: Number.isFinite(nbFrames) ? nbFrames : 0,
    hasDataTrack: streams.some(stream => stream.codec_type === 'data'),
  }
}

function readBodyToFile (req: IncomingMessage, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(filePath)
    let size = 0
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      stream.destroy()
      req.destroy()
      reject(error)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > UPLOAD_MAX_BYTES) {
        fail(new Error('UPLOAD_TOO_LARGE'))
        return
      }
      if (!stream.write(chunk)) {
        req.pause()
        stream.once('drain', () => req.resume())
      }
    })
    req.on('end', () => {
      stream.end(() => {
        if (!settled) {
          settled = true
          resolve()
        }
      })
    })
    req.on('error', fail)
    stream.on('error', fail)
  })
}

async function checkFfmpegAvailable (): Promise<void> {
  try {
    await runCommand('ffmpeg', ['-version'], 15000)
  } catch {
    throw new Error('FFMPEG_MISSING')
  }
}

async function handleExtract (req: IncomingMessage, res: ServerResponse): Promise<void> {
  await checkFfmpegAvailable()

  const dir = await mkdtemp(join(tmpdir(), 'fh2-sim-djmd-'))
  try {
    const videoPath = join(dir, 'upload.mp4')
    const dataPath = join(dir, 'djmd.data')
    await readBodyToFile(req, videoPath)

    const info = await probeVideo(videoPath)
    if (!info.hasDataTrack) {
      throw new Error('NO_DATA_TRACK')
    }

    const extract = await runCommand('ffmpeg', [
      '-y',
      '-i',
      videoPath,
      '-map',
      '0:d:0',
      '-c',
      'copy',
      '-f',
      'data',
      dataPath,
    ])
    if (extract.code !== 0) {
      throw new Error(`ffmpeg 抽取数据轨失败: ${extract.stderr.slice(0, 400)}`)
    }

    const djmd = parseDjmd(await readFile(dataPath))
    if (djmd.frames.length === 0) {
      throw new Error('EMPTY_DJMD')
    }

    const ndjson = buildDjmdReplayNdjson(djmd, {
      width: info.width,
      height: info.height,
      fps: info.fps,
      durationMs: info.durationMs,
    })

    res.statusCode = 200
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(ndjson)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function errorResponse (res: ServerResponse, status: number, message: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: message }))
}

const ERROR_MESSAGES: ReadonlyMap<string, { status: number; message: string }> = new Map([
  ['FFMPEG_MISSING', { status: 503, message: '本机未安装 ffmpeg/ffprobe，无法抽取检测数据轨；请先安装（brew install ffmpeg）后重启 pnpm sim' }],
  ['NO_DATA_TRACK', { status: 422, message: '录像不含检测数据轨（djmd）；请确认是开启 AI 检测的 DJI 机载录像 MP4' }],
  ['EMPTY_DJMD', { status: 422, message: '检测数据轨解析不到任何帧包，无法用于回放' }],
  ['UPLOAD_TOO_LARGE', { status: 413, message: '上传文件超过 4GB 限制' }],
])

export function createSimExtractMiddleware (): RequestHandler {
  return (req, res, next) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== SIM_EXTRACT_ENDPOINT) {
      next()
      return
    }
    if (req.method !== 'POST') {
      errorResponse(res, 405, '仅支持 POST')
      return
    }
    void handleExtract(req, res).catch((error: unknown) => {
      const key = error instanceof Error ? error.message : ''
      const known = ERROR_MESSAGES.get(key)
      if (known) {
        errorResponse(res, known.status, known.message)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error('[sim-extract] 处理失败:', message)
      errorResponse(res, 500, `提取失败: ${message}`)
    })
  }
}
