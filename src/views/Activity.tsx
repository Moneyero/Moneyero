import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "../lib/tauri";
import type { ActivityRow, AuditRow } from "../lib/types";
import { errMsg, ts } from "../lib/format";
import { Btn, Empty, ErrLine, Panel, Seg, Tabs, Td, Th } from "../components/ui";

const MODULES = ["all", "terminal", "monero", "zcash", "exchange", "network", "vault", "process", "app"] as const;

export default function Activity() {
  const [tab, setTab] = useState<"activity" | "audit">("activity");
  const [mod, setMod] = useState<(typeof MODULES)[number]>("all");
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!isTauri) return;
    try {
      setErr(null);
      if (tab === "activity") setRows(await invoke<ActivityRow[]>("activity_list", { module: mod === "all" ? null : mod, limit: 400 }));
      else setAudit(await invoke<AuditRow[]>("audit_list", { limit: 400 }));
    } catch (e) {
      setErr(errMsg(e));
    }
  }, [tab, mod]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="view">
      <Panel
        title="Activity"
        fill
        tight
        right={
          <>
            {tab === "activity" && <Seg options={MODULES} value={mod} onChange={setMod} />}
            <Btn size="xs" onClick={load}>refresh</Btn>
          </>
        }
      >
        <Tabs tabs={[{ id: "activity", label: "events" }, { id: "audit", label: "audit trail" }]} active={tab} onChange={setTab} />
        <div style={{ padding: 6 }}>
          <ErrLine e={err} />
          {!isTauri && <Empty>Activity is stored by the desktop backend. Browser mode has no log.</Empty>}
          {tab === "activity" ? (
            <table className="tbl dense">
              <thead>
                <tr>
                  <Th w={140}>time</Th>
                  <Th w={70}>module</Th>
                  <Th w={110}>kind</Th>
                  <Th w={40}>lvl</Th>
                  <Th>message</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <>
                    <tr key={r.id} className={r.data ? "click" : ""} onClick={() => setOpen(open === r.id ? null : r.id)}>
                      <Td className="dim">{ts(r.ts)}</Td>
                      <Td className="or">{r.module}</Td>
                      <Td className="muted">{r.kind}</Td>
                      <Td className={r.level === "warn" ? "warn" : r.level === "error" ? "err" : "dim"}>{r.level}</Td>
                      <Td wrap>{r.message}{r.data ? <span className="dim"> {open === r.id ? "▾" : "▸"}</span> : null}</Td>
                    </tr>
                    {open === r.id && r.data && (
                      <tr key={`${r.id}-d`}>
                        <Td colSpan={5}><pre className="logbox">{pretty(r.data)}</pre></Td>
                      </tr>
                    )}
                  </>
                ))}
                {!rows.length && isTauri && (
                  <tr><Td colSpan={5}><Empty>no events yet</Empty></Td></tr>
                )}
              </tbody>
            </table>
          ) : (
            <table className="tbl dense">
              <thead>
                <tr>
                  <Th w={140}>time</Th>
                  <Th w={60}>actor</Th>
                  <Th w={180}>event</Th>
                  <Th>detail</Th>
                </tr>
              </thead>
              <tbody>
                {audit.map((r) => (
                  <tr key={r.id}>
                    <Td className="dim">{ts(r.ts)}</Td>
                    <Td className={r.actor === "llm" ? "gold" : r.actor === "rules" ? "or" : "muted"}>{r.actor}</Td>
                    <Td>{r.event}</Td>
                    <Td wrap className="dim">{r.detail ?? ""}</Td>
                  </tr>
                ))}
                {!audit.length && isTauri && (
                  <tr><Td colSpan={4}><Empty>audit trail empty</Empty></Td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </Panel>
    </div>
  );
}

function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
