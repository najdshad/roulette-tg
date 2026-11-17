// Test-only storage controls. Production Worker entrypoints do not import this module.
export async function sessionControl(
  instance: any,
  state: DurableObjectState,
  action: string,
  data: any = {},
) {
  const row = state.storage.sql
    .exec<{ data: string }>("SELECT data FROM session_state LIMIT 1")
    .toArray()[0];
  const saved = row ? JSON.parse(row.data) : null;
  if (action === "inspect")
    return {
      state: saved,
      messages: state.storage.sql.exec("SELECT * FROM ephemeral_messages").toArray(),
      alarm: await state.storage.getAlarm(),
    };
  if (action === "patch" && saved) {
    Object.assign(saved, data);
    state.storage.sql.exec("UPDATE session_state SET data=?", JSON.stringify(saved));
  }
  if (action === "expire") {
    if (saved) {
      for (const view of saved.views) view.expires = Date.now() - 1;
      state.storage.sql.exec("UPDATE session_state SET data=?", JSON.stringify(saved));
    }
    if (data.viewsOnly)
      state.storage.sql.exec(
        "UPDATE ephemeral_messages SET delete_at=? WHERE delete_at<?",
        Date.now() - 1,
        Date.now() + 20_000,
      );
    else state.storage.sql.exec("UPDATE ephemeral_messages SET delete_at=?", Date.now() - 1);
  }
  if (action === "alarm") await instance.alarm();
  return { ok: true };
}
export async function queueControl(instance: any, state: DurableObjectState, action: string) {
  if (action === "inspect") return [...instance.queue.values()];
  if (action === "reset") {
    instance.queue.clear();
    await state.storage.put("queue", []);
    await state.storage.delete("pair");
    await state.storage.deleteAlarm();
  }
  if (action === "expire") {
    for (const entry of instance.queue.values()) entry.joined = Date.now() - 601_000;
    await state.storage.put("queue", [...instance.queue.values()]);
  }
  if (action === "alarm") await instance.alarm();
  if (action === "evict") state.abort("Test eviction");
  return { ok: true };
}
