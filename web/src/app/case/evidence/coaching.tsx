'use client'

import { useActionState } from 'react'
import { requestCoaching } from './actions'

/**
 * Renders the coaching note from the action RESULT — the note never enters a URL.
 * Everything the prompt needs is recomputed server-side inside requestCoaching.
 */
export function CoachingSection() {
  const [state, formAction, pending] = useActionState(requestCoaching, { note: null })

  return (
    <section>
      <h2>Encourage me</h2>
      <form action={formAction}>
        <button type="submit" disabled={pending}>
          {pending ? 'Thinking…' : 'Encourage me'}
        </button>
      </form>
      {state.note && <p role="status">{state.note}</p>}
    </section>
  )
}
