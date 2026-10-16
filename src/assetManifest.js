/**
 * Exact paths of the Blender-made models (each export lives in its own job folder).
 * Source scripts: assets/src/<name>.py. Missing entries fall back to procedural stand-ins.
 */
export const ASSETS = {
  guns: {
    ar: "assets/blender/795dd3a4-29bb-4eba-9108-757a27e361f1/model.glb",
    smg: "assets/blender/26452ced-900e-4018-9932-a55911e41cbd/model.glb",
    shotgun: "assets/blender/9a21e45a-78cd-4941-b0d2-c38ed3d19579/model.glb",
    sniper: "assets/blender/6f396793-1819-4825-979f-7f4184d44aa5/model.glb",
    pistol: "assets/blender/7e150a7b-1ffc-449a-a160-48091828f191/model.glb",
  },
  body: "assets/blender/b1106c6f-1eb0-49d0-81b0-40f7eaac5a38/model.glb",
  gear: "assets/blender/4daa0ced-6265-4094-844b-a0bb25188b90/model.glb",
  /** Recorded sounds. rifle-shot.wav = the Genex rifle shot (assets/genex/5b611718…) normalised +38 dB and trimmed. */
  audio: {
    rifle: "assets/audio/rifle-shot.wav",
  },
};
