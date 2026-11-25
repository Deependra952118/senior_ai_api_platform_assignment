import { randomBytes } from 'node:crypto';

const declined = (detail) => ({ result: JSON.stringify({ ok: false, error: 'declined_by_user', detail }) });

// Human-in-the-loop gate for write tools.
//   elicit  - ask the human through the MCP client (elicitation). Falls back to
//             preview when the client doesn't support elicitation.
//   preview - return a preview + single-use confirmation_id; the host shows it to
//             the user and the model calls again with the id after a "yes".
//   deny    - writes disabled (read-only deployment).
export function createConfirm({ server, mode = 'elicit', store, log = () => {} }) {
  return async ({ tool, args, preview, confirmationId }) => {
    if (mode === 'deny') {
      return { result: JSON.stringify({ ok: false, error: 'writes_disabled', detail: 'This assistant is read-only. Tell the user to make the change in the case console.' }) };
    }

    const caps = server?.server.getClientCapabilities?.();
    if (mode === 'elicit' && caps?.elicitation) {
      try {
        const r = await server.server.elicitInput({
          message: `The assistant wants to run ${tool}:\n\n${preview}\n\nApprove?`,
          requestedSchema: {
            type: 'object',
            properties: { approve: { type: 'boolean', title: 'Approve this action', default: false } },
            required: ['approve'],
          },
        });
        if (r.action === 'accept' && r.content?.approve === true) return { approvalId: `el_${randomBytes(6).toString('hex')}` };
        return declined('The user did not approve this action. Do not retry unless they ask again.');
      } catch (err) {
        log(`elicitation failed (${err.message}); falling back to preview`);
      }
    }

    if (confirmationId) {
      const status = store.redeem(confirmationId, tool, args);
      if (status === 'ok') return { approvalId: confirmationId };
      const why = {
        unknown: 'That confirmation_id is not valid. Ask the user again from a fresh preview.',
        expired: 'The confirmation expired. Show a fresh preview and ask again.',
        mismatch: 'The arguments changed after the user approved. Show a fresh preview and ask again.',
      }[status];
      return { result: JSON.stringify({ ok: false, error: `confirmation_${status}`, detail: why }) };
    }

    return {
      result: JSON.stringify({
        status: 'confirmation_required',
        confirmation_id: store.issue(tool, args),
        preview,
        instructions: 'Show this preview to the user and ask for approval. Only if they clearly say yes, call the same tool again with identical arguments plus confirmation_id. Expires in 5 minutes.',
      }),
    };
  };
}
