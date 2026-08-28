import { useProjectStore } from '../store/projectStore';

let transitionInFlight = false;

/** Returns true only when the caller may safely replace or leave the project. */
export async function confirmProjectTransition(): Promise<boolean> {
  // A second caller must not be allowed to replace the project while the first
  // caller is still prompting or saving.  Returning false keeps the competing
  // transition fail-closed without showing a duplicate native dialog.
  if (transitionInFlight) return false;
  transitionInFlight = true;
  try {
    if (!useProjectStore.getState().isProjectDirty()) return true;
    const choice = await window.cortexlume.project.confirmUnsavedChanges();
    if (choice === 'cancel') return false;
    if (choice === 'discard') return true;

    // Capture the newest state after the prompt. Edits made after this snapshot
    // remain dirty when markProjectSaved advances only the persisted baseline.
    const stateToSave = useProjectStore.getState();
    const projectToSave = structuredClone(stateToSave.project);
    const saved = await window.cortexlume.project.save(projectToSave, stateToSave.projectPath ?? undefined);
    if (!saved) return false;
    useProjectStore.getState().markProjectSaved(projectToSave, saved.path);
    return !useProjectStore.getState().isProjectDirty();
  } finally {
    transitionInFlight = false;
  }
}
