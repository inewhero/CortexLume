import { useProjectStore } from '../store/projectStore';

/** Returns true only when the caller may safely replace or leave the project. */
export async function confirmProjectTransition(): Promise<boolean> {
  const state = useProjectStore.getState();
  if (!state.isProjectDirty()) return true;
  const choice = await window.cortexlume.project.confirmUnsavedChanges();
  if (choice === 'cancel') return false;
  if (choice === 'discard') return true;

  const projectToSave = structuredClone(state.project);
  const saved = await window.cortexlume.project.save(projectToSave, state.projectPath ?? undefined);
  if (!saved) return false;
  useProjectStore.getState().markProjectSaved(projectToSave, saved.path);
  return true;
}
