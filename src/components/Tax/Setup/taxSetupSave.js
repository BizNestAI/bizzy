export async function saveTaxSetupData({
  ensureProfile,
  saveProfile,
  saveMemories,
  refreshCalculation,
  profilePatch,
  memoryPayloads = [],
  mode = "save",
}) {
  if (typeof ensureProfile === "function") await ensureProfile();
  const savedProfile = typeof saveProfile === "function" ? await saveProfile(profilePatch) : null;
  if (typeof saveMemories === "function" && memoryPayloads.length) {
    await saveMemories(memoryPayloads);
  }
  if (mode === "save_and_calculate" && typeof refreshCalculation === "function") {
    await refreshCalculation();
  }
  return savedProfile;
}
