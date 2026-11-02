import { expect, test } from "bun:test"
import { pushToast } from "../../lib/toast-stack"
import { STAR_NUDGE_MESSAGE, showStarNudgeToast } from "../star-nudge"
import type { ToastOptions } from "../toast"

type Item = ToastOptions & { message: string }

test("later notifications do not evict the star nudge from the capped stack", () => {
  let stack: Item[] = []
  showStarNudgeToast(() => {}, (message, opts) => {
    stack = pushToast(stack, { message, ...opts })
    return 0
  })
  for (let i = 0; i < 8; i++) stack = pushToast(stack, { message: `saved ${i}` })
  expect(stack.map((t) => t.message)).toEqual([STAR_NUDGE_MESSAGE, "saved 5", "saved 6", "saved 7"])
})

test("non-sticky toasts keep the newest four", () => {
  let stack: Item[] = []
  for (let i = 0; i < 6; i++) stack = pushToast(stack, { message: `t${i}` })
  expect(stack.map((t) => t.message)).toEqual(["t2", "t3", "t4", "t5"])
})
