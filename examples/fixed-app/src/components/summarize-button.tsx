"use client";

import { summarize } from "@/lib/summarize";

export function SummarizeButton({ text }: { text: string }) {
  return <button onClick={async () => alert(await summarize(text))}>Summarize</button>;
}
