"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icon, Input, Spinner } from "@/components/ui";
import { Logo } from "@/components/Logo";
import { backendStatus, postSession } from "@/lib/api";
import { isFirebaseConfigured, googleSignIn, emailSignIn } from "@/lib/firebase";

function GoogleG() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

const FEATURES = [
  { icon: "Download", t: "Export any campaign to CSV with a precise column picker" },
  { icon: "GitMerge", t: "Merge voice + messaging batches into one unified file" },
  { icon: "Sparkles", t: "AI insights, anomaly detection & natural-language Q&A" },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [loading, setLoading] = useState(false);
  const [method, setMethod] = useState<"google" | "email" | "token" | null>(null);
  const [error, setError] = useState("");
  const [backendOn, setBackendOn] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [idToken, setIdToken] = useState("");

  useEffect(() => {
    backendStatus().then((s) => setBackendOn(s.backend));
  }, []);

  const submit = async (e: React.FormEvent | null, via: "google" | "email" | "token") => {
    e?.preventDefault();
    setMethod(via);
    setError("");
    setLoading(true);
    try {
      const { backend } = await backendStatus();
      if (!backend) {
        // mock mode — no real auth, just advance
        setTimeout(() => router.push("/workspace"), 950);
        return;
      }
      let token = "";
      if (via === "token") {
        token = idToken.trim();
        if (!token) throw new Error("Paste a Firebase ID token first.");
      } else if (!isFirebaseConfigured()) {
        throw new Error("Firebase isn't configured. Use the ID-token option below for local testing.");
      } else {
        token = via === "google" ? await googleSignIn() : await emailSignIn(email, pwd);
      }
      await postSession(token);
      router.push("/workspace");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      setMethod(null);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-stretch">
      {/* left brand panel */}
      <div className="hidden lg:flex relative w-[44%] flex-col justify-between p-12 overflow-hidden" style={{ background: "radial-gradient(120% 120% at 0% 0%, #1e1b4b 0%, #312e81 38%, #4338ca 100%)" }}>
        <div className="absolute inset-0 opacity-[0.5]" style={{ backgroundImage: "radial-gradient(circle at 80% 20%, rgba(139,63,214,0.55), transparent 45%), radial-gradient(circle at 15% 85%, rgba(59,130,246,0.45), transparent 45%)" }} />
        <div className="relative">
          <Logo size={44} light />
        </div>
        <div className="relative">
          <div className="text-white/90 text-[34px] font-extrabold leading-[1.12] tracking-tight max-w-md">
            Turn finished campaigns into{" "}
            <span className="text-transparent bg-clip-text" style={{ backgroundImage: "linear-gradient(90deg,#c4b5fd,#93c5fd)" }}>
              decisions.
            </span>
          </div>
          <div className="mt-5 text-white/55 text-[15px] max-w-sm leading-relaxed">
            Download, merge, and analyze your MagickVoice call &amp; messaging campaigns — all in one workspace.
          </div>
          <div className="mt-9 flex flex-col gap-3">
            {FEATURES.map((f, i) => (
              <div key={i} className="flex items-center gap-3 text-white/80 text-sm">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 backdrop-blur">
                  <Icon name={f.icon} size={16} />
                </span>
                {f.t}
              </div>
            ))}
          </div>
        </div>
        <div className="relative text-white/40 text-xs">© 2026 MagickVoice · SOC 2 Type II · DPDP compliant</div>
      </div>

      {/* right form */}
      <div className="flex-1 flex items-center justify-center p-6 bg-[#f6f7f9]">
        <div className="w-full max-w-[400px] fade-up">
          <div className="lg:hidden mb-8 flex justify-center">
            <Logo size={42} />
          </div>
          <div className="mb-7">
            <h1 className="text-[26px] font-extrabold tracking-tight text-slate-900">Sign in to MagickUtils</h1>
            <p className="text-slate-500 text-sm mt-1.5">Download, merge, and analyze your MagickVoice campaigns.</p>
          </div>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-700 fade-in">
              <Icon name="AlertCircle" size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button onClick={(e) => submit(e, "google")} disabled={loading} className="w-full h-11 rounded-xl border border-slate-200 bg-white font-semibold text-sm text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all flex items-center justify-center gap-3 shadow-sm disabled:opacity-60">
            {loading && method === "google" ? <Spinner size={16} /> : <GoogleG />}
            Continue with Google
          </button>

          <div className="my-5 flex items-center gap-3 text-xs text-slate-400">
            <div className="h-px flex-1 bg-slate-200" /> or sign in with email <div className="h-px flex-1 bg-slate-200" />
          </div>

          <form onSubmit={(e) => submit(e, "email")} className="space-y-3.5">
            <div>
              <label className="block text-[13px] font-semibold text-slate-600 mb-1.5">Work email</label>
              <Input icon="Mail" type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-[13px] font-semibold text-slate-600">Password</label>
                <a className="text-[13px] font-semibold text-[var(--accent-strong)] hover:underline cursor-pointer">Forgot?</a>
              </div>
              <Input icon="Lock" type="password" placeholder="••••••••••" value={pwd} onChange={(e) => setPwd(e.target.value)} required />
            </div>
            <Button type="submit" size="lg" className="w-full" loading={loading && method === "email"} iconRight={loading ? undefined : "ArrowRight"}>
              Sign in
            </Button>
          </form>

          {backendOn && (
            <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <button type="button" onClick={() => setShowToken((s) => !s)} className="flex w-full items-center justify-between text-[13px] font-semibold text-slate-600">
                <span className="flex items-center gap-1.5">
                  <Icon name="KeyRound" size={14} /> Sign in with a Firebase ID token (testing)
                </span>
                <Icon name={showToken ? "ChevronUp" : "ChevronDown"} size={15} className="text-slate-400" />
              </button>
              {showToken && (
                <div className="mt-3 space-y-2.5">
                  <textarea
                    value={idToken}
                    onChange={(e) => setIdToken(e.target.value)}
                    placeholder="Paste a Firebase ID token (eyJ…)"
                    rows={3}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] font-mono text-slate-800 placeholder:text-slate-400 placeholder:font-sans focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)] resize-none"
                  />
                  <Button type="button" variant="secondary" size="sm" className="w-full" loading={loading && method === "token"} onClick={() => submit(null, "token")}>
                    Use ID token
                  </Button>
                </div>
              )}
            </div>
          )}

          <p className="mt-6 text-center text-sm text-slate-500">
            New to MagickVoice? <a className="font-semibold text-[var(--accent-strong)] hover:underline cursor-pointer">Talk to sales</a>
          </p>
        </div>
      </div>
    </div>
  );
}
