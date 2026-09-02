/**
 * Mirrors the backend's fixed literal Junk Email folder path (email-worker's
 * `microsoft-types.ts` `MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS`). Not user-editable
 * and Graph-only (card C-4) — this constant exists so the frontend never has to
 * import worker code to recognize the same literal.
 */
export const MICROSOFT_JUNK_FOLDER_PATH = 'Junk Email'

export function isMicrosoftJunkFolderPath(folderPath: string): boolean {
  return folderPath.toUpperCase() === MICROSOFT_JUNK_FOLDER_PATH.toUpperCase()
}
