'use client'

import { useActionState, useEffect, useState } from 'react'
import { saveAnswer, shapeAnswer, type ShapeState } from './actions'
import type { KurtaKey } from '@/lib/nexus'

/**
 * One Kurta question: a textarea the veteran owns, a Save button, and an
 * optional "Help me phrase this" button. The shape result is a PROPOSAL only —
 * it lands in this component's local text state (never the DB, never a URL)
 * and is saved only when the veteran presses Save.
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

  useEffect(() => {
    if (state.shapedAnswer) setText(state.shapedAnswer)
  }, [state.shapedAnswer])

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
            onChange={(e) => setText(e.target.value)}
            rows={8}
          />
        </label>
        {state.gaps && <p role="status">Something to consider: {state.gaps}</p>}
        <button type="submit" formAction={saveAnswer}>Save</button>
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
