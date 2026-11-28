const audioFields = ['voiceFile', 'voiceName', 'voiceDuration', 'voiceBytes', 'voiceTrimStart', 'voiceTrimEnd', 'voiceOffset'];

export function takesFor(segment) {
  if (Array.isArray(segment.takes)) return segment.takes;
  if (!segment.voiceFile) return [];
  // Stable IDs let old projects be read without a write or revision change.
  return [{ id: `legacy-${segment.id}`, createdAt: null, ...Object.fromEntries(audioFields.map(key => [key, segment[key]])) }];
}

export function ensureTakes(segment) {
  segment.takes = takesFor(segment);
  segment.selectedTakeId ||= segment.takes[0]?.id || null;
  return segment.takes;
}

export function selectTake(segment, id) {
  const take = ensureTakes(segment).find(take => take.id === id);
  if (!take) return false;
  segment.selectedTakeId = id;
  for (const key of audioFields) {
    if (take[key] === undefined) delete segment[key]; else segment[key] = take[key];
  }
  segment.voiceTrimStart ||= 0; segment.voiceTrimEnd ||= 0; segment.voiceOffset ||= 0;
  // An older take may have an offset from before the line's timing was edited.
  if (segment.start + segment.voiceOffset < 0 || segment.start + segment.voiceOffset >= segment.end) {
    segment.voiceOffset = 0; take.voiceOffset = 0;
  }
  return true;
}

export function saveTakeEdits(segment) {
  const take = ensureTakes(segment).find(take => take.id === segment.selectedTakeId);
  if (take) for (const key of ['voiceTrimStart', 'voiceTrimEnd', 'voiceOffset']) take[key] = segment[key] || 0;
}

export function projectFiles(project) {
  return [...new Set([project?.diskName, project?.mixFile, ...(project?.segments || []).flatMap(segment => takesFor(segment).map(take => take.voiceFile))].filter(Boolean))];
}
