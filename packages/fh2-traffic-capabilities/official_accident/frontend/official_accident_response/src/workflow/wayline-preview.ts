// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type {
  GeoPoint,
  PlatformWaylinePreviewDestination,
  PlatformWaylinePreviewInput,
  PluginCapabilityClient,
  PluginLogger,
} from 'fh2-plugin-sdk'
import { errorLogDetail } from './errors'

export interface WaylinePreviewRoute {
  readonly id: string;
  readonly label: string;
  readonly coordinates?: readonly GeoPoint[];
}

export interface WaylinePreview {
  show(input: {
    readonly previewId: string;
    readonly routes: readonly WaylinePreviewRoute[];
    readonly selectedIndex: number;
    readonly startPosition: GeoPoint;
    readonly destination: PlatformWaylinePreviewDestination;
  }): Promise<void>;
  clear(previewId: string): Promise<void>;
  dispose(): Promise<void>;
}

export function createWaylinePreview (
  capability: PluginCapabilityClient<'platform:wayline-preview'> | undefined,
  logger: PluginLogger,
): WaylinePreview {
  type PreviewHandle = Awaited<ReturnType<NonNullable<typeof capability>['show']>>
  const owners = new Map<string, { sequence: number; handle: PreviewHandle | undefined }>()

  async function clear (previewId: string): Promise<void> {
    const owner = owners.get(previewId)
    if (!owner) return
    owners.delete(previewId)
    owner.sequence++
    await owner.handle?.dispose()
  }

  return {
    async show ({ previewId, routes, selectedIndex, startPosition, destination }) {
      await clear(previewId)
      if (!capability) return
      const owner = { sequence: 1, handle: undefined as PreviewHandle | undefined }
      owners.set(previewId, owner)
      const sequence = owner.sequence
      const selectedRoute = routes[selectedIndex]
      try {
        const handle = await capability.show(toWaylinePreviewInputDto({
          points: selectedRoute?.coordinates ?? [],
          startPosition,
          destination,
        }))
        if (owners.get(previewId) !== owner || owner.sequence !== sequence) {
          await handle.dispose()
          return
        }
        owner.handle = handle
      } catch (error) {
        if (owners.get(previewId) === owner) owners.delete(previewId)
        logger.warn('专业航线预览创建失败，业务流程继续', {
          previewId,
          selectedRouteId: selectedRoute?.id ?? '',
          ...errorLogDetail(error, '航线预览创建失败'),
        })
      }
    },
    clear,
    async dispose () {
      await Promise.allSettled([...owners.keys()].map(clear))
    },
  }
}

function toPointDto (point: GeoPoint): GeoPoint {
  return { lng: point.lng, lat: point.lat, height: point.height }
}

// Keep the Capability boundary detached from View state even in a direct Realm.
function toWaylinePreviewInputDto (input: PlatformWaylinePreviewInput): PlatformWaylinePreviewInput {
  return {
    points: input.points.map(toPointDto),
    startPosition: input.startPosition ? toPointDto(input.startPosition) : null,
    destination: input.destination
      ? { position: toPointDto(input.destination.position), kind: input.destination.kind }
      : null,
  }
}
