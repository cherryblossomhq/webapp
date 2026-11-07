import type { View } from "./uiStore"

/** What a message is about, as the top bar's Feedback form offers it. */
export type FeedbackTopic = "broken" | "idea" | "other"

export const FEEDBACK_TOPICS: Record<FeedbackTopic, string> = {
  broken: "Something's broken",
  idea: "An idea or request",
  other: "Something else",
}

/** The form stops typing at this. */
export const MAX_FEEDBACK_CHARS = 5000

/** One message from the Feedback form, with where in the editor it was written. */
export interface EditorFeedback {
  topic?: FeedbackTopic
  message: string
  /** The project open, if one is. */
  projectId?: string
  view: View
}

/**
 * Where the top bar's Feedback form sends what is typed in it: the host's, as the editor sends no
 * events of its own (the website's is a survey in its analytics).
 * Without one there is no Feedback button.
 */
export interface FeedbackSink {
  /** Resolves once the message is on its way; rejects when it can't be sent, which the form says. */
  send(feedback: EditorFeedback): Promise<void>
  /** The form was opened. */
  opened?(): void
  /** The form was closed with nothing sent. */
  dismissed?(): void
  /** An address to write to instead, offered when sending fails. */
  contactEmail?: string
}

let sink: FeedbackSink | undefined

export const connectFeedback = (next: FeedbackSink | undefined) => {
  sink = next
}

export const feedbackSink = () => sink
