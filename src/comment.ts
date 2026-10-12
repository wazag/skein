export const REPORT_MARKER = "<!-- skein-report:v1 -->";

// Minimal shape of the Octokit calls the upsert needs, so Task 11's adapter stays a thin shim.
export type CommentApi = {
  listComments(prNumber: number): Promise<Array<{ id: number; body: string }>>;
  updateComment(commentId: number, body: string): Promise<void>;
  createComment(prNumber: number, body: string): Promise<void>;
};

// Exactly one Skein comment per PR: refresh the marked one when present, otherwise create it.
// The marker travels inside the body, so a freshly rendered report is always self-identifying.
export async function upsertComment(api: CommentApi, prNumber: number, body: string): Promise<void> {
  const existing = (await api.listComments(prNumber)).find((comment) => comment.body.includes(REPORT_MARKER));
  if (existing === undefined) {
    await api.createComment(prNumber, body);
    return;
  }
  await api.updateComment(existing.id, body);
}
