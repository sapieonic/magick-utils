"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Icon, cx } from "@/components/ui";
import { Logo } from "@/components/Logo";
import { WORKSPACES } from "@/lib/data";
import { backendStatus, fetchMe, listAccounts, postContext, type SessionAccountInfo, type SessionTenantInfo } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { Workspace } from "@/lib/types";

export default function WorkspacePage() {
  const router = useRouter();
  const { setWorkspace, signOut } = useApp();
  const [tenant, setTenant] = useState("");
  const [account, setAccount] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showSuggest, setShowSuggest] = useState(false);
  const [showAcctSuggest, setShowAcctSuggest] = useState(false);
  const [backendOn, setBackendOn] = useState(false);
  const [list, setList] = useState<Workspace[]>(WORKSPACES);
  // Live tenants the user belongs to (from the login payload); empty in mock mode.
  const [liveTenants, setLiveTenants] = useState<SessionTenantInfo[]>([]);
  // Accounts for the currently selected tenant, fetched on demand (cascade) since
  // the login payload doesn't nest them. Empty ⇒ manual account entry.
  const [accountsForTenant, setAccountsForTenant] = useState<SessionAccountInfo[]>([]);
  const [acctLoading, setAcctLoading] = useState(false);
  const wrapRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowSuggest(false);
        setShowAcctSuggest(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // when the backend is live, populate suggestions from the user's real tenants
  useEffect(() => {
    backendStatus().then(async (s) => {
      setBackendOn(s.backend);
      if (!s.backend) return;
      const me = await fetchMe().catch(() => null);
      if (me?.tenants?.length) {
        setLiveTenants(me.tenants);
        setList(me.tenants.map((t) => ({ name: t.name ?? t.id, tenant: t.id, account: "", role: "" })));
      } else {
        setLiveTenants([]);
        setList([]);
      }
    });
  }, []);

  // Cascade: once a known tenant is selected in live mode, fetch its accounts so
  // the user picks from a list instead of typing an id. Auto-selects a sole
  // account; opens the picker when there are several. Clears (→ manual entry)
  // when the tenant is empty/unknown or the backend is off.
  useEffect(() => {
    const t = tenant.trim();
    const known = liveTenants.some((lt: SessionTenantInfo) => lt.id === t);
    if (!backendOn || !t || !known) {
      setAccountsForTenant([]);
      return;
    }
    let active = true;
    setAcctLoading(true);
    listAccounts(t)
      .then((accts) => {
        if (!active) return;
        setAccountsForTenant(accts);
        if (accts.length === 1) {
          setAccount(accts[0].id);
          setShowAcctSuggest(false);
        } else if (accts.length > 1) {
          setShowAcctSuggest(true);
        }
      })
      .finally(() => {
        if (active) setAcctLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tenant, backendOn, liveTenants]);

  // Pick a tenant: fill it and clear any prior account. In mock mode the seeded
  // account is preset directly; in live mode the cascade effect above loads it.
  const chooseTenant = (tenantId: string, presetAccount?: string) => {
    setTenant(tenantId);
    setError("");
    setShowSuggest(false);
    setAccount(presetAccount ?? "");
    if (presetAccount) setShowAcctSuggest(false);
  };

  const chooseAccount = (accountId: string) => {
    setAccount(accountId);
    setError("");
    setShowAcctSuggest(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = tenant.trim();
    const a = account.trim();
    if (!t || !a) {
      setError("Both Tenant ID and Account ID are required.");
      return;
    }
    setError("");
    setLoading(true);

    if (backendOn) {
      try {
        await postContext(t, a);
        const matched = list.find((w: Workspace) => w.tenant === t);
        const acct = accountsForTenant.find((x: SessionAccountInfo) => x.id === a);
        setWorkspace({
          name: matched?.name ?? t,
          tenant: t,
          account: a,
          accountName: acct?.name ?? acct?.slug ?? undefined,
          role: matched?.role || "Member",
        });
        router.push("/dashboard");
      } catch (err) {
        const msg = String(err).includes("tenant_not_accessible")
          ? `You don't have access to ${t}. Pick one of your workspaces below.`
          : `Couldn't open ${t} / ${a}. Check the IDs and try again.`;
        setError(msg);
        setLoading(false);
      }
      return;
    }

    // mock mode — validate against seeded workspaces
    const match = WORKSPACES.find((w) => w.tenant === t && w.account === a);
    if (!match) {
      setError(`No workspace found for ${t} / ${a}, or you don't have access. Check the IDs or pick one below.`);
      setLoading(false);
      return;
    }
    setTimeout(() => {
      setWorkspace(match);
      router.push("/dashboard");
    }, 850);
  };

  const onBack = () => {
    signOut();
    router.push("/login");
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-6 bg-[#f6f7f9]" style={{ backgroundImage: "radial-gradient(60% 50% at 50% -5%, #eef2ff 0%, transparent 60%)" }}>
      <div className="w-full max-w-[480px] fade-up">
        <div className="flex justify-center mb-7">
          <Logo size={42} />
        </div>
        <Card className="p-7">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--accent-strong)] mb-2">
            <Icon name="Building2" size={14} /> WORKSPACE
          </div>
          <h1 className="text-[22px] font-extrabold tracking-tight text-slate-900">Choose your workspace</h1>
          <p className="text-slate-500 text-sm mt-1.5">Pick a tenant you belong to, then choose an account within it. You can also enter the IDs manually.</p>

          <form onSubmit={submit} className="mt-6 space-y-4" ref={wrapRef}>
            <div className="relative">
              <label className="block text-[13px] font-semibold text-slate-600 mb-1.5">Tenant ID</label>
              <div className="relative flex items-center">
                <Icon name="Hash" size={16} className="absolute left-3 text-slate-400 pointer-events-none" />
                <input
                  className={cx(
                    "h-10 w-full rounded-xl border bg-white text-sm font-mono text-slate-800 placeholder:text-slate-400 placeholder:font-sans transition-all focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] pl-9 pr-9",
                    error ? "border-red-300" : "border-slate-200 focus:border-[var(--accent)]",
                  )}
                  placeholder="tenant_xxxx"
                  value={tenant}
                  onFocus={() => {
                    setShowSuggest(true);
                    setShowAcctSuggest(false);
                  }}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setTenant(e.target.value);
                    setError("");
                  }}
                />
                <button type="button" onClick={() => setShowSuggest((s: boolean) => !s)} className="absolute right-2.5 text-slate-400 hover:text-slate-600">
                  <Icon name="ChevronDown" size={16} />
                </button>
              </div>

              {showSuggest && (
                <div className="absolute left-0 right-0 z-30 mt-2 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl fade-up">
                  <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">Your workspaces</div>
                  {list.length === 0 && <div className="px-2.5 py-2 text-[13px] text-slate-400">No workspaces found — enter IDs manually.</div>}
                  {list.map((w: Workspace) => (
                    <button type="button" key={w.tenant} onClick={() => chooseTenant(w.tenant, w.account || undefined)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-slate-100 transition-colors text-left">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white text-xs font-bold shrink-0" style={{ background: "var(--brand-grad)" }}>
                        {w.name[0]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-slate-800 truncate">{w.name}</span>
                        <span className="block text-[11px] font-mono text-slate-400 truncate">
                          {w.tenant}{w.account ? ` / ${w.account}` : ""}
                        </span>
                      </span>
                      {w.role && (
                        <Badge soft="#f1f5f9" text="#64748b">
                          {w.role}
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="relative">
              <label className="block text-[13px] font-semibold text-slate-600 mb-1.5">
                Account ID
                {acctLoading && <span className="ml-2 font-normal text-slate-400">loading accounts…</span>}
                {!acctLoading && accountsForTenant.length > 0 && (
                  <span className="ml-2 font-normal text-slate-400">
                    {accountsForTenant.length} account{accountsForTenant.length === 1 ? "" : "s"} available
                  </span>
                )}
              </label>
              <div className="relative flex items-center">
                <Icon name="User" size={16} className="absolute left-3 text-slate-400 pointer-events-none" />
                <input
                  className={cx(
                    "h-10 w-full rounded-xl border bg-white text-sm font-mono text-slate-800 placeholder:text-slate-400 placeholder:font-sans transition-all focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] pl-9",
                    accountsForTenant.length > 0 ? "pr-9" : "pr-3",
                    error ? "border-red-300" : "border-slate-200 focus:border-[var(--accent)]",
                  )}
                  placeholder={accountsForTenant.length > 0 ? "Choose or type an account…" : "acct_xxxx"}
                  value={account}
                  onFocus={() => {
                    if (accountsForTenant.length > 0) setShowAcctSuggest(true);
                    setShowSuggest(false);
                  }}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setAccount(e.target.value);
                    setError("");
                  }}
                />
                {accountsForTenant.length > 0 && (
                  <button type="button" onClick={() => setShowAcctSuggest((s: boolean) => !s)} className="absolute right-2.5 text-slate-400 hover:text-slate-600">
                    <Icon name="ChevronDown" size={16} />
                  </button>
                )}
              </div>

              {showAcctSuggest && accountsForTenant.length > 0 && (
                <div className="absolute left-0 right-0 z-30 mt-2 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl fade-up">
                  <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">Accounts in this tenant</div>
                  {accountsForTenant.map((a: SessionAccountInfo) => (
                    <button type="button" key={a.id} onClick={() => chooseAccount(a.id)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-slate-100 transition-colors text-left">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500 shrink-0">
                        <Icon name="User" size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-slate-800 truncate">{a.name ?? a.slug ?? a.id}</span>
                        <span className="block text-[11px] font-mono text-slate-400 truncate">{a.id}</span>
                      </span>
                      {account === a.id && <Icon name="Check" size={16} className="text-[var(--accent)]" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-700 fade-in">
                <Icon name="AlertCircle" size={16} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" size="lg" className="w-full" loading={loading} iconRight={loading ? undefined : "ArrowRight"}>
              Continue
            </Button>
          </form>
        </Card>

        <button onClick={onBack} className="mt-5 mx-auto flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700 transition-colors">
          <Icon name="LogOut" size={15} /> Sign out
        </button>
      </div>
    </div>
  );
}
