import { Check, MessageSquareText } from "lucide-react"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { FEEDBACK_TOPICS, MAX_FEEDBACK_CHARS, feedbackSink, type FeedbackTopic } from "../store/feedback"
import { useProjectStore } from "../store/projectStore"
import { useUi } from "../store/uiStore"
import { Button, useDismiss } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"

type Status = "idle" | "sending" | "sent" | "failed"

const TOPICS = Object.keys(FEEDBACK_TOPICS) as FeedbackTopic[]

/** How long the thanks shows before the form closes by itself. */
const THANKS_MS = 2500

/**
 * The top bar's Feedback button and its form: a topic, a message, Send. Where it goes is the host's
 * (`FeedbackSink`); without one there is no button. The draft outlives closing the form, so a click
 * on the canvas doesn't throw away what was typed; sending clears it.
 */
export function FeedbackButton() {
  const sink = feedbackSink()
  const projectId = useProjectStore((s) => s.project?.id)
  const [open, setOpen] = useState(false)
  const [topic, setTopic] = useState<FeedbackTopic>()
  const [message, setMessage] = useState("")
  const [status, setStatus] = useState<Status>("idle")
  // Whether anything was sent while it was open: closing after that, or while it is on its way, is
  // not a dismissal.
  const sent = useRef(false)
  const ref = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)

  const close = () => {
    setOpen(false)
    if (!sent.current && status !== "sending") sink?.dismissed?.()
  }
  useDismiss(ref, open, close)

  useEffect(() => {
    if (open) field.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open || status !== "sent") return
    const t = setTimeout(() => setOpen(false), THANKS_MS)
    return () => clearTimeout(t)
  }, [open, status])

  if (!sink) return null

  const show = () => {
    sent.current = false
    // A failure stays: a send that failed after the form was closed says so when it opens again.
    if (status === "sent") setStatus("idle")
    setOpen(true)
    sink.opened?.()
  }

  const send = async () => {
    if (!message.trim() || status === "sending") return
    setStatus("sending")
    try {
      await sink.send({ topic, message: message.trim(), projectId, view: useUi.getState().view })
      sent.current = true
      setStatus("sent")
      setTopic(undefined)
      setMessage("")
    } catch {
      setStatus("failed")
    }
  }

  // The canvas's shortcuts listen on the window, and none is for the form: Delete would delete the
  // selection behind it. Escape closes it, and puts the focus back on the button.
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === "Escape") {
      e.preventDefault()
      close()
      ref.current?.querySelector("button")?.focus()
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div ref={ref} className="relative">
      <Tooltip label="Send feedback" hint="A bug, an idea, anything: it goes to the team">
        <Button variant="ghost" onClick={() => (open ? close() : show())} aria-expanded={open} aria-haspopup="dialog" aria-label="Feedback">
          <MessageSquareText size={15} /> <span className="hidden xl:inline">Feedback</span>
        </Button>
      </Tooltip>
      {open && (
        <div
          role="dialog"
          aria-label="Send feedback"
          onKeyDown={onKeyDown}
          className="absolute right-0 top-10 z-30 w-[340px] animate-pop-in rounded-[10px] border border-line bg-surface p-3 shadow-menu"
        >
          {status === "sent" ? (
            <div role="status" className="flex items-center gap-2.5 px-1 py-1.5 text-[13px] font-medium text-ink">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-chrome-2 text-ok">
                <Check size={15} />
              </span>
              Thanks, it's with the team.
            </div>
          ) : (
            <form
              className="flex flex-col gap-2.5"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
            >
              <div className="text-[13px] font-[650] text-ink">Send feedback</div>
              <div role="group" aria-label="What is it about?" className="flex flex-wrap gap-1.5">
                {TOPICS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={topic === key}
                    onClick={() => setTopic((t) => (t === key ? undefined : key))}
                    className={`h-7 rounded-full border px-2.5 text-[12px] font-medium transition-colors ${
                      topic === key ? "border-ink bg-ink text-surface" : "border-line text-ink-2 hover:bg-chrome hover:text-ink"
                    }`}
                  >
                    {FEEDBACK_TOPICS[key]}
                  </button>
                ))}
              </div>
              <textarea
                ref={field}
                aria-label="Your feedback"
                rows={5}
                maxLength={MAX_FEEDBACK_CHARS}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What's working, what isn't, what you'd like to see."
                className="w-full resize-none rounded-[var(--radius-ctl)] border border-line bg-field px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-select"
              />
              {status === "failed" && (
                <p role="alert" className="text-[12px] text-danger">
                  It couldn't be sent. Try again
                  {sink.contactEmail ? (
                    <>
                      , or email it to{" "}
                      <a href={`mailto:${sink.contactEmail}`} className="underline underline-offset-2">
                        {sink.contactEmail}
                      </a>
                    </>
                  ) : null}
                  .
                </p>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] text-ink-3">⌘↵ to send</span>
                <Button type="submit" variant="primary" disabled={!message.trim() || status === "sending"}>
                  {status === "sending" ? "Sending…" : "Send"}
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
