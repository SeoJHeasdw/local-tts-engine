import fs from 'node:fs';
import path from 'node:path';

// Compatibility data for the approved voice installed before voice profiles.
// New speakers are described by their dataset and voice-profile.json only.
const legacy = JSON.parse(fs.readFileSync(new URL('../../config/legacy-voice.json', import.meta.url), 'utf8'));

export function legacyVoiceForRoot(root) {
  return { ...legacy, ...Object.fromEntries(['trainJsonl', 'referenceAudioPath', 'referenceTextPath']
    .map(key => [key, path.resolve(root, legacy[key])])) };
}
