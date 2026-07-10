'use client'

import { useActionState, useState } from 'react'
import { saveAnswer, shapeAnswer, type SaveState, type ShapeState } from './actions'
import type { KurtaKey } from '@/lib/nexus'

/**
 * One Kurta question: a textarea the veteran owns, a Save button, and an
 * optional "Help me phrase this" button. The shape result is a PROPOSAL only —
 * it lands in this component's local text state (never the DB, never a URL)
 * and is saved only when the veteran presses Save. Save is a state-returning
 * action (no redirect) so pressing it never blows away unsaved text in the
 * other three questions.
 */
export function NexusQuestion({
  qKey, prompt, explainer, initialText,
}: {
  qKey: KurtaKey
  prompt: string
  explainer: string
  initialText: string
}) {
  const [text, setText] = useState(initialText)
  const [state, shapeFormAction, shaping] = useActionState<ShapeState, FormData>(
    shapeAnswer,
    { shapedAnswer: null, gaps: null },
  )
  const [saveState, saveFormAction, saving] = useActionState<SaveState, FormData>(
    saveAnswer,
    { saved: false, error: null },
  )

  // Adjust state during render (not in an effect) when a NEW proposal arrives —
  // guarded so it fires once per proposal rather than on every re-render.
  const [appliedShapedAnswer, setAppliedShapedAnswer] = useState<string | null>(null)
  if (state.shapedAnswer && state.shapedAnswer !== appliedShapedAnswer) {
    setAppliedShapedAnswer(state.shapedAnswer)
    setText(state.shapedAnswer)
  }

  // "Saved." must not linger once the veteran edits again — track edits since
  // the last save result, with the same adjust-during-render idiom as above.
  const [seenSaveState, setSeenSaveState] = useState<SaveState | null>(null)
  const [editedSinceSave, setEditedSinceSave] = useState(false)
  if (saveState !== seenSaveState) {
    setSeenSaveState(saveState)
    setEditedSinceSave(false)
  }

  return (
    <section>
      <h3>{prompt}</h3>
      <p>{explainer}</p>
      <form>
        <input type="hidden" name="questionKey" value={qKey} />
        <label>
          Your answer
          <textarea
            name="text"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setEditedSinceSave(true)
            }}
            rows={8}
          />
        </label>
        {state.gaps && <p role="status">Something to consider: {state.gaps}</p>}
        {saveState.saved && !editedSinceSave && <p role="status">Saved.</p>}
        {saveState.error && !editedSinceSave && <p role="alert">{saveState.error}</p>}
        <button type="submit" formAction={saveFormAction} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="submit"
          formAction={shapeFormAction}
          disabled={shaping || text.trim().length === 0}
        >
          {shaping ? 'Thinking…' : 'Help me phrase this'}
        </button>
      </form>
    </section>
  )
}
