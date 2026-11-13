"use client";

export function SummarizeButton({ text }: { text: string }) {
  async function summarize() {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-6.1-terra", input: `Summarize: ${text}` }),
    });
    alert((await res.json()).output_text);
  }
  return <button onClick={summarize}>Summarize</button>;
}
