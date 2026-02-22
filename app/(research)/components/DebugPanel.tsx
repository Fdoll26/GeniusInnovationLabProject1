'use client';

import { useEffect, useState } from 'react';

function getCookie(name: string) {
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.split('=')[1];
}

async function setDebugCookie(params: {
  bypass: boolean;
  stub: boolean;
  stubRefiner: boolean;
  stubOpenAI: boolean;
  stubGemini: boolean;
  stubEmail: boolean;
  stubPdf: boolean;
  skipOpenAI: boolean;
  skipGemini: boolean;
}) {
  await fetch('/api/debug/bypass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
}

export default function DebugPanel({
  onBypassChange
}: {
  onBypassChange?: (enabled: boolean) => void;
}) {
  const enabled =
    process.env.NEXT_PUBLIC_DEBUG_PANEL === '1' ||
    process.env.NEXT_PUBLIC_DEBUG_PANEL === 'true';
  if (process.env.NODE_ENV === 'production' || !enabled) {
    return null;
  }
  const [open, setOpen] = useState(false);
  const [bypass, setBypass] = useState(false);
  const [stub, setStub] = useState(false);
  const [stubRefiner, setStubRefiner] = useState(false);
  const [stubOpenAI, setStubOpenAI] = useState(false);
  const [stubGemini, setStubGemini] = useState(false);
  const [stubEmail, setStubEmail] = useState(false);
  const [stubPdf, setStubPdf] = useState(false);
  const [skipOpenAI, setSkipOpenAI] = useState(false);
  const [skipGemini, setSkipGemini] = useState(false);
  const [testTopic, setTestTopic] = useState('Debug report');
  const [testOpenaiText, setTestOpenaiText] = useState('OpenAI debug output');
  const [testGeminiText, setTestGeminiText] = useState('Gemini debug output');
  const [debugMessage, setDebugMessage] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('debug') === '1') {
      setOpen(true);
      setDebugCookie({
        bypass: true,
        stub: true,
        stubRefiner: true,
        stubOpenAI: true,
        stubGemini: true,
        stubEmail: true,
        stubPdf: true,
        skipOpenAI: false,
        skipGemini: false
      }).then(() => {
        setBypass(true);
        setStub(true);
        setStubRefiner(true);
        setStubOpenAI(true);
        setStubGemini(true);
        setStubEmail(true);
        setStubPdf(true);
        onBypassChange?.(true);
      });
      url.searchParams.delete('debug');
      window.history.replaceState({}, '', url.toString());
    }

    setBypass(getCookie('dev_bypass') === '1');
    setStub(getCookie('dev_stub') === '1');
    setStubRefiner(getCookie('dev_stub_refiner') === '1');
    setStubOpenAI(getCookie('dev_stub_openai') === '1');
    setStubGemini(getCookie('dev_stub_gemini') === '1');
    setStubEmail(getCookie('dev_stub_email') === '1');
    setStubPdf(getCookie('dev_stub_pdf') === '1');
    setSkipOpenAI(getCookie('dev_skip_openai') === '1');
    setSkipGemini(getCookie('dev_skip_gemini') === '1');
  }, [onBypassChange]);

  async function toggleBypass(next: boolean) {
    const nextState = {
      bypass: next,
      stub,
      stubRefiner,
      stubOpenAI,
      stubGemini,
      stubEmail,
      stubPdf,
      skipOpenAI,
      skipGemini
    };
    await setDebugCookie(nextState);
    setBypass(next);
    onBypassChange?.(next);
  }

  async function toggleStub(next: boolean) {
    const nextState = {
      bypass,
      stub: next,
      stubRefiner,
      stubOpenAI,
      stubGemini,
      stubEmail,
      stubPdf,
      skipOpenAI,
      skipGemini
    };
    await setDebugCookie(nextState);
    setStub(next);
  }

  async function updateAdvanced(next: {
    stubRefiner?: boolean;
    stubOpenAI?: boolean;
    stubGemini?: boolean;
    stubEmail?: boolean;
    stubPdf?: boolean;
    skipOpenAI?: boolean;
    skipGemini?: boolean;
  }) {
    const nextState = {
      bypass,
      stub,
      stubRefiner: next.stubRefiner ?? stubRefiner,
      stubOpenAI: next.stubOpenAI ?? stubOpenAI,
      stubGemini: next.stubGemini ?? stubGemini,
      stubEmail: next.stubEmail ?? stubEmail,
      stubPdf: next.stubPdf ?? stubPdf,
      skipOpenAI: next.skipOpenAI ?? skipOpenAI,
      skipGemini: next.skipGemini ?? skipGemini
    };
    await setDebugCookie(nextState);
    setStubRefiner(nextState.stubRefiner);
    setStubOpenAI(nextState.stubOpenAI);
    setStubGemini(nextState.stubGemini);
    setStubEmail(nextState.stubEmail);
    setStubPdf(nextState.stubPdf);
    setSkipOpenAI(nextState.skipOpenAI);
    setSkipGemini(nextState.skipGemini);
  }

  async function sendTestReport() {
    setDebugMessage(null);
    const response = await fetch('/api/debug/test-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: testTopic,
        openaiText: testOpenaiText,
        geminiText: testGeminiText
      })
    });
    if (!response.ok) {
      setDebugMessage('Test report failed');
    } else {
      setDebugMessage('Test report sent');
    }
  }

  async function seedSession() {
    setDebugMessage(null);
    const response = await fetch('/api/debug/seed-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: testTopic,
        refinedPrompt: testTopic,
        openaiText: testOpenaiText,
        geminiText: testGeminiText
      })
    });
    if (!response.ok) {
      setDebugMessage('Seed session failed');
    } else {
      setDebugMessage('Seed session created');
    }
  }

  return (
    <div className="card stack">
      <div className="row">
        <strong>Debug Panel</strong>
        <button type="button" className="button-secondary" onClick={() => setOpen((prev) => !prev)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open ? (
        <>
          <label className="row">
            <input
              type="checkbox"
              checked={bypass}
              onChange={(event) => toggleBypass(event.target.checked)}
            />
            Bypass Google OAuth (dev only)
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={stub}
              onChange={(event) => toggleStub(event.target.checked)}
            />
            Stub external APIs (OpenAI, Gemini, Email, PDF)
          </label>
          <div className="stack">
            <label className="row">
              <input
                type="checkbox"
                checked={stubRefiner}
                onChange={(event) => updateAdvanced({ stubRefiner: event.target.checked })}
              />
              Stub clarification + rewrite
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={stubOpenAI}
                onChange={(event) => updateAdvanced({ stubOpenAI: event.target.checked })}
              />
              Stub OpenAI deep research
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={stubGemini}
                onChange={(event) => updateAdvanced({ stubGemini: event.target.checked })}
              />
              Stub Gemini research
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={stubEmail}
                onChange={(event) => updateAdvanced({ stubEmail: event.target.checked })}
              />
              Stub email send
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={stubPdf}
                onChange={(event) => updateAdvanced({ stubPdf: event.target.checked })}
              />
              Stub PDF generation
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={skipOpenAI}
                onChange={(event) => updateAdvanced({ skipOpenAI: event.target.checked })}
              />
              Skip OpenAI run
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={skipGemini}
                onChange={(event) => updateAdvanced({ skipGemini: event.target.checked })}
              />
              Skip Gemini run
            </label>
          </div>
          <div className="stack">
            <strong>Test Tools</strong>
            <label className="stack">
              <span>Test topic</span>
              <input value={testTopic} onChange={(event) => setTestTopic(event.target.value)} />
            </label>
            <label className="stack">
              <span>OpenAI report text</span>
              <textarea
                rows={3}
                value={testOpenaiText}
                onChange={(event) => setTestOpenaiText(event.target.value)}
              />
            </label>
            <label className="stack">
              <span>Gemini report text</span>
              <textarea
                rows={3}
                value={testGeminiText}
                onChange={(event) => setTestGeminiText(event.target.value)}
              />
            </label>
            <div className="row">
              <button type="button" onClick={sendTestReport}>
                Send test report email
              </button>
              <button type="button" onClick={seedSession}>
                Create debug session
              </button>
            </div>
            {debugMessage ? <small>{debugMessage}</small> : null}
          </div>
          <small>Tip: add ?debug=1 to the URL to auto-enable.</small>
        </>
      ) : null}
    </div>
  );
}
