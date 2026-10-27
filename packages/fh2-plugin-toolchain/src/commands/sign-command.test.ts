// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { createPublicKey, generateKeyPairSync, verify as nodeVerify } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { KEY_ID_ENV_NAME, PRIVATE_KEY_ENV_NAME, PUBLIC_KEY_ENV_NAME } from '../sign/keys.js'
import { collectPackageFiles, digestPackageFiles, parsePackageSignature } from '../sign/signature.js'
import { runSignCommand } from './sign-command.js'

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function generateKeyPair (): { readonly privateKey: Buffer; readonly publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  return {
    privateKey: Buffer.concat([pkcs8.subarray(pkcs8.byteLength - 32), spki.subarray(spki.byteLength - 32)]),
    publicKey: Buffer.from(spki.subarray(spki.byteLength - 32)),
  }
}

function verifyWithPublicKey (publicKey: Buffer, digest: Buffer, sig: Buffer): boolean {
  const keyObject = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' })
  return nodeVerify(null, digest, keyObject, sig)
}

function writers (): { stdout: string[]; stderr: string[]; stdoutWrite: (v: string) => void; stderrWrite: (v: string) => void } {
  const stdout: string[] = []
  const stderr: string[] = []
  return { stdout, stderr, stdoutWrite: value => stdout.push(value), stderrWrite: value => stderr.push(value) }
}

const temporaryDirectories: string[] = []

function createWorkspace (): { root: string; inputRoot: string; outputZipPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'fh2-sign-cli-'))
  temporaryDirectories.push(root)
  const inputRoot = join(root, 'pkg')
  mkdirSync(inputRoot, { recursive: true })
  writeFileSync(join(inputRoot, 'packages.json'), '{"packageId":"demo"}')
  return { root, inputRoot, outputZipPath: join(root, 'demo-signed.zip') }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('runSignCommand', () => {
  it.each([
    [[], '缺少必填参数：--in、--out'],
    [['--in', 'package'], '缺少必填参数：--out'],
    [['--out', 'package.zip'], '缺少必填参数：--in'],
  ])('缺参 %j 只指出实际缺少项，并保持退出 2', async (args, expected) => {
    const out = writers()
    expect(await runSignCommand({
      args,
      cwd: process.cwd(),
      stdout: { write: out.stdoutWrite },
      stderr: { write: out.stderrWrite },
      env: {},
    })).toBe(2)
    expect(out.stderr.join('').split('\n')[0]).toBe(expected)
    expect(out.stdout).toEqual([])
  })

  it('目录 → 签名 zip：顶层 SIGNATURE 可被独立验签，stdout 打印 sha256 与条目数', async () => {
    const { privateKey, publicKey } = generateKeyPair()
    const workspace = createWorkspace()
    const out = writers()
    const code = await runSignCommand({
      args: ['--in', workspace.inputRoot, '--out', workspace.outputZipPath],
      cwd: workspace.root,
      stdout: { write: out.stdoutWrite },
      stderr: { write: out.stderrWrite },
      env: {
        [PRIVATE_KEY_ENV_NAME]: privateKey.toString('base64'),
        [PUBLIC_KEY_ENV_NAME]: publicKey.toString('base64'),
        [KEY_ID_ENV_NAME]: 'demo-2026-09',
      },
    })
    expect(code).toBe(0)
    expect(out.stderr).toEqual([])
    expect(out.stdout.join('')).toContain('已签名打包')
    expect(out.stdout.join('')).toMatch(/SHA256 [0-9a-f]{64}/)

    // 独立复算：zip 内 SIGNATURE 与源文件集合自洽（公钥可验证）
    const files = collectPackageFiles(workspace.inputRoot)
    const zipEntries = readZipEntries(readFileSync(workspace.outputZipPath))
    const signatureEntry = zipEntries.find(entry => entry.path === 'SIGNATURE')
    expect(signatureEntry).toBeDefined()
    const parsed = parsePackageSignature(signatureEntry!.data)
    expect(parsed).not.toBeNull()
    expect(parsed!.keyId).toBe('demo-2026-09')
    expect(verifyWithPublicKey(publicKey, digestPackageFiles(files), parsed!.sig)).toBe(true)
    expect(zipEntries.map(entry => entry.path).sort()).toEqual(['SIGNATURE', 'packages.json'])
  })

  it('确定性：同素材同密钥两次签名逐字节相同', async () => {
    const { privateKey, publicKey } = generateKeyPair()
    const workspace = createWorkspace()
    const env = {
      [PRIVATE_KEY_ENV_NAME]: privateKey.toString('base64'),
      [PUBLIC_KEY_ENV_NAME]: publicKey.toString('base64'),
    }
    const out1 = writers()
    const out2 = writers()
    const code1 = await runSignCommand({
      args: ['--in', workspace.inputRoot, '--out', join(workspace.root, 'a.zip')],
      cwd: workspace.root,
      stdout: { write: out1.stdoutWrite },
      stderr: { write: out1.stderrWrite },
      env,
    })
    const code2 = await runSignCommand({
      args: ['--in', workspace.inputRoot, '--out', join(workspace.root, 'b.zip')],
      cwd: workspace.root,
      stdout: { write: out2.stdoutWrite },
      stderr: { write: out2.stderrWrite },
      env,
    })
    expect(code1).toBe(0)
    expect(code2).toBe(0)
    expect(readFileSync(join(workspace.root, 'a.zip')).equals(readFileSync(join(workspace.root, 'b.zip')))).toBe(true)
  })

  it('--keyid 参数优先于 FH2_PLUGIN_SIGN_KEY_ID 环境变量', async () => {
    const { privateKey, publicKey } = generateKeyPair()
    const workspace = createWorkspace()
    const out = writers()
    const code = await runSignCommand({
      args: ['--in', workspace.inputRoot, '--out', workspace.outputZipPath, '--keyid', 'cli-key'],
      cwd: workspace.root,
      stdout: { write: out.stdoutWrite },
      stderr: { write: out.stderrWrite },
      env: {
        [PRIVATE_KEY_ENV_NAME]: privateKey.toString('base64'),
        [PUBLIC_KEY_ENV_NAME]: publicKey.toString('base64'),
        [KEY_ID_ENV_NAME]: 'env-key',
      },
    })
    expect(code).toBe(0)
    const zipEntries = readZipEntries(readFileSync(workspace.outputZipPath))
    const parsed = parsePackageSignature(zipEntries.find(entry => entry.path === 'SIGNATURE')!.data)
    expect(parsed!.keyId).toBe('cli-key')
  })

  it('密钥文件路径形态（CI File 变量 / 本地密钥文件）', async () => {
    const { privateKey, publicKey } = generateKeyPair()
    const workspace = createWorkspace()
    const privPath = join(workspace.root, 'demo.priv')
    const pubPath = join(workspace.root, 'demo.pub')
    writeFileSync(privPath, privateKey)
    writeFileSync(pubPath, publicKey)
    const out = writers()
    const code = await runSignCommand({
      args: ['--in', workspace.inputRoot, '--out', workspace.outputZipPath],
      cwd: workspace.root,
      stdout: { write: out.stdoutWrite },
      stderr: { write: out.stderrWrite },
      env: { [PRIVATE_KEY_ENV_NAME]: privPath, [PUBLIC_KEY_ENV_NAME]: pubPath },
    })
    expect(code).toBe(0)
    expect(out.stderr).toEqual([])
  })

  it('公私钥不配对：失败、不产出 zip、错误含 FH2_SIGN_KEY_MISMATCH', async () => {
    const { privateKey } = generateKeyPair()
    const other = generateKeyPair()
    const workspace = createWorkspace()
    const out = writers()
    const code = await runSignCommand({
      args: ['--in', workspace.inputRoot, '--out', workspace.outputZipPath],
      cwd: workspace.root,
      stdout: { write: out.stdoutWrite },
      stderr: { write: out.stderrWrite },
      env: {
        [PRIVATE_KEY_ENV_NAME]: privateKey.toString('base64'),
        [PUBLIC_KEY_ENV_NAME]: other.publicKey.toString('base64'),
      },
    })
    expect(code).toBe(1)
    expect(out.stderr.join('')).toContain('FH2_SIGN_KEY_MISMATCH')
    expect(existsSync(workspace.outputZipPath)).toBe(false)
  })

  it.each(['子路径', '同一路径', '输出祖先软链', '输入目录软链', '输出文件软链', '输入内软链指外', '输出祖先与文件双软链'])('拒绝输入输出重叠（%s），输入不变', async (scenario) => {
    const keys = generateKeyPair()
    const workspace = createWorkspace()
    let inputRoot = workspace.inputRoot
    let outputZipPath = join(inputRoot, 'overlap.zip')
    if (scenario === '同一路径') {
      outputZipPath = inputRoot
    } else if (scenario === '输出祖先软链') {
      const alias = join(workspace.root, 'output-alias')
      symlinkSync(inputRoot, alias, 'dir')
      outputZipPath = join(alias, 'new-directory', 'overlap.zip')
    } else if (scenario === '输入目录软链') {
      inputRoot = join(workspace.root, 'input-alias')
      symlinkSync(workspace.inputRoot, inputRoot, 'dir')
    } else if (scenario === '输出文件软链') {
      outputZipPath = workspace.outputZipPath
      symlinkSync(join(inputRoot, 'packages.json'), outputZipPath, 'file')
    } else if (scenario === '输入内软链指外') {
      const alias = join(inputRoot, 'redirect')
      symlinkSync(workspace.root, alias, 'dir')
      outputZipPath = join(alias, 'overlap.zip')
    } else if (scenario === '输出祖先与文件双软链') {
      const alias = join(workspace.root, 'output-alias')
      symlinkSync(inputRoot, alias, 'dir')
      writeFileSync(workspace.outputZipPath, 'previous archive')
      outputZipPath = join(alias, 'overlap.zip')
      symlinkSync(workspace.outputZipPath, outputZipPath, 'file')
    }
    const before = collectPackageFiles(workspace.inputRoot)
    const entriesBefore = readdirSync(workspace.inputRoot)
    const out = writers()
    const code = await runSignCommand({
      args: ['--in', inputRoot, '--out', outputZipPath],
      cwd: workspace.root,
      stdout: { write: out.stdoutWrite },
      stderr: { write: out.stderrWrite },
      env: { [PRIVATE_KEY_ENV_NAME]: keys.privateKey.toString('base64'), [PUBLIC_KEY_ENV_NAME]: keys.publicKey.toString('base64') },
    })

    expect(code).toBe(1)
    expect(out.stdout).toEqual([])
    expect(out.stderr.join('')).toContain('FH2_SIGN_PATH_UNSAFE')
    expect(out.stderr.join('')).toContain('独立输出目录')
    expect(collectPackageFiles(workspace.inputRoot)).toEqual(before)
    expect(readdirSync(workspace.inputRoot)).toEqual(entriesBefore)
    if (scenario === '输出文件软链' || scenario === '输出祖先与文件双软链') expect(lstatSync(outputZipPath).isSymbolicLink()).toBe(true)
    if (scenario === '输入内软链指外') expect(existsSync(join(workspace.root, 'overlap.zip'))).toBe(false)
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0).each(['现有目录', '新建子目录'])('真实 readonly 输出失败（%s），保留原包且无候选残留', async (scenario) => {
    const keys = generateKeyPair()
    const workspace = createWorkspace()
    const outputRoot = join(workspace.root, 'readonly')
    mkdirSync(outputRoot)
    writeFileSync(join(outputRoot, 'signed.zip'), 'previous archive')
    const before = collectPackageFiles(workspace.inputRoot)
    const out = writers()
    chmodSync(outputRoot, 0o555)
    try {
      expect(() => writeFileSync(join(outputRoot, 'permission-probe'), 'probe')).toThrow(/EACCES|EPERM/)
      const code = await runSignCommand({
        args: ['--in', workspace.inputRoot, '--out', join(outputRoot, ...(scenario === '新建子目录' ? ['new-directory'] : []), 'signed.zip')],
        cwd: workspace.root,
        stdout: { write: out.stdoutWrite },
        stderr: { write: out.stderrWrite },
        env: { [PRIVATE_KEY_ENV_NAME]: keys.privateKey.toString('base64'), [PUBLIC_KEY_ENV_NAME]: keys.publicKey.toString('base64') },
      })

      expect(code).toBe(1)
      expect(out.stdout).toEqual([])
      expect(out.stderr.join('')).toContain('FH2_SIGN_OUTPUT_WRITE_FAILED')
      expect(out.stderr.join('')).toMatch(/EACCES|EPERM/)
      expect(collectPackageFiles(workspace.inputRoot)).toEqual(before)
      expect(readdirSync(outputRoot)).toEqual(['signed.zip'])
      expect(readFileSync(join(outputRoot, 'signed.zip'), 'utf8')).toBe('previous archive')
    } finally {
      chmodSync(outputRoot, 0o755)
    }
  })

  it('缺少必填参数：退出码 2 并打印帮助', async () => {
    const out = writers()
    const code = await runSignCommand({
      args: ['--in', '/tmp/x'],
      cwd: '/tmp',
      stdout: { write: out.stdoutWrite },
      stderr: { write: out.stderrWrite },
      env: {},
    })
    expect(code).toBe(2)
    expect(out.stderr.join('').split('\n')[0]).toBe('缺少必填参数：--out')
  })

  it('环境变量未设置：退出码 1 并提示变量名', async () => {
    const workspace = createWorkspace()
    const out = writers()
    const code = await runSignCommand({
      args: ['--in', workspace.inputRoot, '--out', workspace.outputZipPath],
      cwd: workspace.root,
      stdout: { write: out.stdoutWrite },
      stderr: { write: out.stderrWrite },
      env: {},
    })
    expect(code).toBe(1)
    expect(out.stderr.join('')).toContain('FH2_SIGN_KEY_ENV_MISSING')
  })

  it('--help：打印帮助且不触达密钥环境变量', async () => {
    const out = writers()
    const code = await runSignCommand({
      args: ['--help'],
      cwd: '/tmp',
      stdout: { write: out.stdoutWrite },
      stderr: { write: out.stderrWrite },
      env: {},
    })
    expect(code).toBe(0)
    expect(out.stdout.join('')).toContain('FH2_PLUGIN_SIGN_PRIVATE_KEY')
  })

  it('噪声文件不进产物：.DS_Store 剔除', async () => {
    const { privateKey, publicKey } = generateKeyPair()
    const workspace = createWorkspace()
    writeFileSync(join(workspace.inputRoot, '.DS_Store'), 'noise')
    const out = writers()
    const code = await runSignCommand({
      args: ['--in', workspace.inputRoot, '--out', workspace.outputZipPath],
      cwd: workspace.root,
      stdout: { write: out.stdoutWrite },
      stderr: { write: out.stderrWrite },
      env: {
        [PRIVATE_KEY_ENV_NAME]: privateKey.toString('base64'),
        [PUBLIC_KEY_ENV_NAME]: publicKey.toString('base64'),
      },
    })
    expect(code).toBe(0)
    const paths = readZipEntries(readFileSync(workspace.outputZipPath)).map(entry => entry.path)
    expect(paths).not.toContain('.DS_Store')
  })
})

/** 极简 zip 条目读取（本地头遍历 + raw inflate，与 pack/verifyZipMatchesCandidate 同口径）。 */
function readZipEntries (archive: Buffer): Array<{ path: string; data: Buffer }> {
  const entries: Array<{ path: string; data: Buffer }> = []
  let offset = 0
  while (offset + 30 <= archive.byteLength) {
    if (archive.readUInt32LE(offset) !== 0x04034B50) break
    const method = archive.readUInt16LE(offset + 8)
    const compressedSize = archive.readUInt32LE(offset + 18)
    const nameLength = archive.readUInt16LE(offset + 26)
    const extraLength = archive.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const path = archive.subarray(nameStart, nameStart + nameLength).toString('utf8')
    const compressed = archive.subarray(dataStart, dataStart + compressedSize)
    entries.push({ path, data: method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed) })
    offset = dataStart + compressedSize
  }
  return entries
}
