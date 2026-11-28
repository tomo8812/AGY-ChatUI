import type { InputVideoTrack } from 'mediabunny';

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

export async function inspectVideoMetadata(buffer: Buffer) {
  // Explicitly use single-file formats. Target inspection must never follow
  // paths or URLs from a playlist or external media reference.
  const { Input, BufferSource, MP4, QTFF, WEBM, MATROSKA, MPEG_TS, OGG } = await import('mediabunny');
  const input = new Input({ formats: [MP4, QTFF, WEBM, MATROSKA, MPEG_TS, OGG], source: new BufferSource(buffer) });
  try {
    const tracks = await input.getVideoTracks();
    const track: InputVideoTrack | undefined = tracks[0];
    if (!track) return null;
    const [start, end, width, height, codec] = await Promise.all([
      input.getFirstTimestamp(),
      input.computeDuration(undefined, { skipLiveWait: true }),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.getCodec(),
    ]);
    const durationSeconds = end - start;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
        !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 || !codec) return null;
    return { durationSeconds, widthPx: width, heightPx: height, codec };
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}
