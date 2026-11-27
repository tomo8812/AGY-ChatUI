import { createHash } from 'node:crypto';
import type { InputVideoTrack } from 'mediabunny';

export interface VideoFrameTarget {
  expectedDurationSec: number;
  expectedWidthPx: number;
  expectedHeightPx: number;
  expectedFrameSha256: string;
  frameStartSec: number;
  frameDurationSec: number;
  packetTimestampSec: number;
  packetSha256: string;
}

export async function inspectMediaMetadata(buffer: Buffer, filename: string, mimeType: string) {
  try {
    const { parseBuffer } = await import('music-metadata');
    const { format } = await parseBuffer(buffer, { path: filename, mimeType }, { duration: true, skipCovers: true });
    const durationSeconds = format.duration;
    if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
    return { durationSeconds, codec: format.codec, container: format.container };
  } catch {
    return null;
  }
}

export async function inspectVideoTarget(buffer: Buffer, sourceSha256: string, timestampSec?: number) {
  // Explicitly use single-file formats. Target inspection must never follow
  // paths or URLs from a playlist or external media reference.
  const { Input, BufferSource, EncodedPacketSink, MP4, QTFF, WEBM, MATROSKA, MPEG_TS, OGG } = await import('mediabunny');
  const input = new Input({ formats: [MP4, QTFF, WEBM, MATROSKA, MPEG_TS, OGG], source: new BufferSource(buffer) });
  try {
    const tracks = await input.getVideoTracks();
    const track: InputVideoTrack | undefined = tracks[0];
    if (!track) return null;
    const [start, end, width, height, codec] = await Promise.all([
      input.getFirstTimestamp(), input.computeDuration(undefined, { skipLiveWait: true }),
      track.getDisplayWidth(), track.getDisplayHeight(), track.getCodec(),
    ]);
    const durationSeconds = end - start;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
        !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 || !codec) return null;

    let frame: VideoFrameTarget | undefined;
    if (timestampSec !== undefined && timestampSec >= 0 && timestampSec < durationSeconds) {
      const timestamp = start + timestampSec;
      const packet = await new EncodedPacketSink(track).getPacket(timestamp, { skipLiveWait: true });
      if (packet && packet.data.length > 0 && Number.isFinite(packet.timestamp) && Number.isFinite(packet.duration) &&
          timestamp >= packet.timestamp && timestamp < packet.timestamp + packet.duration) {
        const packetSha256 = createHash('sha256').update(packet.data).digest('hex');
        // The access unit identifies the frame; bind the immutable source as
        // well so decoder configuration and inter-frame references cannot drift.
        const expectedFrameSha256 = createHash('sha256').update(JSON.stringify([
          'encoded-video-frame-v1', sourceSha256, codec, packetSha256, packet.timestamp, packet.duration, width, height,
        ])).digest('hex');
        frame = {
          expectedDurationSec: durationSeconds, expectedWidthPx: width, expectedHeightPx: height, expectedFrameSha256,
          frameStartSec: packet.timestamp - start, frameDurationSec: packet.duration,
          packetTimestampSec: packet.timestamp, packetSha256,
        };
      }
    }
    return { durationSeconds, widthPx: width, heightPx: height, codec, frame };
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}
