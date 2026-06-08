import path from "path";

const ATTACHED_AUDIO_MARKER_RE = /\[attached_audio:\s*([^\]]+)\]/g;

export function createCurrentTurnNativeMediaStore() {
  const activeTurnsBySessionPath = new Map();
  let nextId = 1;

  function begin(sessionPath, opts: { audios?: any[]; audioAttachmentPaths?: any[] } = {}) {
    const normalizedSessionPath = normalizePathKey(sessionPath);
    if (!normalizedSessionPath) return null;
    const audios = Array.isArray(opts.audios) ? opts.audios : [];
    const audioAttachmentPaths = Array.isArray(opts.audioAttachmentPaths) ? opts.audioAttachmentPaths : [];
    if (!audios.length || !audioAttachmentPaths.length) return null;

    const audiosByPathKey = new Map();
    const count = Math.min(audios.length, audioAttachmentPaths.length);
    for (let i = 0; i < count; i += 1) {
      const audio = normalizeAudioBlock(audios[i]);
      if (!audio) continue;
      for (const key of pathKeys(audioAttachmentPaths[i])) {
        audiosByPathKey.set(key, audio);
      }
    }
    if (audiosByPathKey.size === 0) return null;

    const turn = {
      id: nextId,
      sessionPath: normalizedSessionPath,
      audiosByPathKey,
    };
    nextId += 1;
    const stack = activeTurnsBySessionPath.get(normalizedSessionPath) || [];
    stack.push(turn);
    activeTurnsBySessionPath.set(normalizedSessionPath, stack);
    return { id: turn.id, sessionPath: normalizedSessionPath };
  }

  function end(token) {
    if (!token?.sessionPath || !token.id) return;
    const normalizedSessionPath = normalizePathKey(token.sessionPath);
    const stack = activeTurnsBySessionPath.get(normalizedSessionPath);
    if (!stack?.length) return;
    const nextStack = stack.filter((turn) => turn.id !== token.id);
    if (nextStack.length) {
      activeTurnsBySessionPath.set(normalizedSessionPath, nextStack);
    } else {
      activeTurnsBySessionPath.delete(normalizedSessionPath);
    }
  }

  function clearSession(sessionPath) {
    const normalizedSessionPath = normalizePathKey(sessionPath);
    if (!normalizedSessionPath) return false;
    return activeTurnsBySessionPath.delete(normalizedSessionPath);
  }

  function inject(sessionPath, messages) {
    const normalizedSessionPath = normalizePathKey(sessionPath);
    const stack = normalizedSessionPath ? activeTurnsBySessionPath.get(normalizedSessionPath) : null;
    const turn = stack?.[stack.length - 1] || null;
    if (!turn || !Array.isArray(messages)) {
      return { messages, changed: false, injectedAudios: 0 };
    }

    const target = findLatestUserMessageWithActiveAudioMarker(messages, turn);
    if (!target) return { messages, changed: false, injectedAudios: 0 };

    const missingAudios = [];
    for (const markerPath of target.markerPaths) {
      const audio = findAudioForPath(turn, markerPath);
      if (!audio) continue;
      if (contentHasAudioBlock(target.message.content, audio)) continue;
      missingAudios.push(audio);
    }
    if (missingAudios.length === 0) return { messages, changed: false, injectedAudios: 0 };

    const nextMessages = messages.slice();
    nextMessages[target.index] = {
      ...target.message,
      content: [
        ...target.message.content,
        ...missingAudios.map((audio) => ({ ...audio })),
      ],
    };
    return { messages: nextMessages, changed: true, injectedAudios: missingAudios.length };
  }

  return { begin, end, clearSession, inject };
}

function findLatestUserMessageWithActiveAudioMarker(messages, turn) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const markerPaths = extractAttachedAudioMarkerPaths(message.content)
      .filter((markerPath) => !!findAudioForPath(turn, markerPath));
    if (markerPaths.length > 0) return { index, message, markerPaths };
  }
  return null;
}

function extractAttachedAudioMarkerPaths(content) {
  const paths = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") continue;
    ATTACHED_AUDIO_MARKER_RE.lastIndex = 0;
    let match;
    while ((match = ATTACHED_AUDIO_MARKER_RE.exec(block.text)) !== null) {
      const filePath = match[1]?.trim();
      if (filePath) paths.push(filePath);
    }
  }
  return paths;
}

function findAudioForPath(turn, filePath) {
  for (const key of pathKeys(filePath)) {
    const audio = turn.audiosByPathKey.get(key);
    if (audio) return audio;
  }
  return null;
}

function contentHasAudioBlock(content, expectedAudio) {
  return content.some((block) => (
    block
    && typeof block === "object"
    && block.type === "audio"
    && block.data === expectedAudio.data
    && block.mimeType === expectedAudio.mimeType
  ));
}

function normalizeAudioBlock(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type !== "audio") return null;
  if (typeof value.data !== "string" || !value.data) return null;
  if (typeof value.mimeType !== "string" || !value.mimeType) return null;
  return {
    type: "audio",
    data: value.data,
    mimeType: value.mimeType,
  };
}

function pathKeys(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return [];
  const keys = new Set([raw, path.normalize(raw)]);
  try {
    keys.add(path.resolve(raw));
  } catch {
    // Ignore malformed platform paths; exact matching still covers the marker.
  }
  try {
    keys.add(path.win32.normalize(raw));
    if (path.win32.isAbsolute(raw)) keys.add(path.win32.resolve(raw));
  } catch {
    // Same as above.
  }
  return Array.from(keys).filter(Boolean);
}

function normalizePathKey(value) {
  return pathKeys(value)[0] || "";
}
