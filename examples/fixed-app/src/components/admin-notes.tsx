"use client";

import { useEffect, useState } from "react";

export function AdminNotes() {
  const [notes, setNotes] = useState<{ id: number; body: string }[]>([]);
  useEffect(() => {
    fetch("/api/admin/notes")
      .then((r) => (r.ok ? r.json() : []))
      .then(setNotes);
  }, []);
  return (
    <ul>
      {notes.map((n) => (
        <li key={n.id}>{n.body}</li>
      ))}
    </ul>
  );
}
