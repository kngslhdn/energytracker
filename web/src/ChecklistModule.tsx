import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ClipboardCheck, RefreshCw, Send, ShieldCheck } from 'lucide-react';

type Template = { id: string; name: string; version: number };
type Shift = { id: string; code: string; name: string; start_time: string; end_time: string };
type Item = { id: string; template_id: string; area: string; equipment: string; label: string; input_type: string; unit: string | null; min_value: string | null; max_value: string | null; is_required: boolean; instructions: string | null; sort_order: number };
type Submission = { id: string; shift_date: string; status: string; submitted_at: string; template_name: string; shift_name: string; submitted_by: string; response_count: number; findings_count: number };
type Answer = { value: string; remarks: string; finding: string; correctiveAction: string };

const emptyAnswer = (): Answer => ({ value: '', remarks: '', finding: '', correctiveAction: '' });
const localDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

export default function ChecklistModule({ api, userRole }: { api: string; userRole: string }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [shiftDate, setShiftDate] = useState(localDate());
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const selectedItems = useMemo(() => items.filter(item => item.template_id === templateId), [items, templateId]);
  const updateAnswer = (id: string, field: keyof Answer, value: string) => setAnswers(prev => ({ ...prev, [id]: { ...(prev[id] || emptyAnswer()), [field]: value } }));

  const refresh = async () => {
    setLoading(true);
    try {
      const [optionsResponse, submissionsResponse] = await Promise.all([
        fetch(`${api}/checklists/options`, { credentials: 'include' }),
        fetch(`${api}/checklists`, { credentials: 'include' })
      ]);
      if (!optionsResponse.ok || !submissionsResponse.ok) throw new Error('Unable to load checklist data. Check database migrations and access permissions.');
      const options = await optionsResponse.json();
      const rows = await submissionsResponse.json();
      setTemplates(options.templates || []);
      setShifts(options.shifts || []);
      setItems(options.items || []);
      setSubmissions(rows || []);
      setTemplateId(current => current || options.templates?.[0]?.id || '');
      setShiftId(current => current || options.shifts?.[0]?.id || '');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to load checklist data.');
    } finally { setLoading(false); }
  };

  useEffect(() => { void refresh(); }, [api]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice('Submitting checklist…');
    try {
      const payload = {
        templateId, shiftId, shiftDate,
        responses: selectedItems.map(item => {
          const answer = answers[item.id] || emptyAnswer();
          let value: unknown = answer.value;
          if (item.input_type === 'boolean') value = answer.value === '' ? '' : answer.value === 'true';
          return { itemId: item.id, value, remarks: answer.remarks, finding: answer.finding, correctiveAction: answer.correctiveAction };
        })
      };
      const response = await fetch(`${api}/checklists`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Checklist submission failed.');
      setNotice(result.message || 'Checklist submitted.');
      setAnswers({});
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Checklist submission failed.');
    } finally { setBusy(false); }
  };

  const review = async (id: string, decision: 'approved' | 'needs_action') => {
    setBusy(true);
    try {
      const response = await fetch(`${api}/checklists/${id}/review`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Review failed.');
      setNotice(result.message || 'Review saved.');
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Review failed.');
    } finally { setBusy(false); }
  };

  return <div className="checklist-module">
    <section className="panel reading-panel">
      <div className="panel-head"><div><h2>Shift checklist</h2><p>Record actual checks and flag findings for supervisor review.</p></div><ClipboardCheck size={20} className="muted-icon" /></div>
      {loading ? <p className="empty-state">Loading checklist configuration…</p> : templates.length === 0 || shifts.length === 0 || items.length === 0 ?
        <div className="empty-state"><b>Checklist configuration is not ready yet.</b><p>An administrator must configure at least one active checklist template, its items, and an active shift in PostgreSQL before submissions can be recorded.</p></div> :
        <form className="reading-form" onSubmit={submit}>
          <label>Checklist template<select value={templateId} onChange={e => { setTemplateId(e.target.value); setAnswers({}); }} required>{templates.map(t => <option key={t.id} value={t.id}>{t.name} · v{t.version}</option>)}</select></label>
          <label>Shift<select value={shiftId} onChange={e => setShiftId(e.target.value)} required>{shifts.map(s => <option key={s.id} value={s.id}>{s.name} ({String(s.start_time).slice(0,5)}–{String(s.end_time).slice(0,5)})</option>)}</select></label>
          <label>Operational date<input type="date" value={shiftDate} onChange={e => setShiftDate(e.target.value)} required /></label>
          {selectedItems.map((item, index) => <div className="checklist-item-form" key={item.id}>
            <div className="checklist-item-heading"><span>{String(index + 1).padStart(2,'0')}</span><div><b>{item.label}</b><small>{item.area} · {item.equipment}{item.unit ? ` · ${item.unit}` : ''}</small></div>{item.is_required && <span className="status-tag pending-tag">Required</span>}</div>
            {item.instructions && <p className="checklist-instructions">{item.instructions}</p>}
            {item.input_type === 'numeric' ? <label>Measured value{item.unit ? ` (${item.unit})` : ''}<input type="number" step="any" value={(answers[item.id] || emptyAnswer()).value} onChange={e => updateAnswer(item.id,'value',e.target.value)} required={item.is_required} placeholder={item.min_value !== null || item.max_value !== null ? `Configured range: ${item.min_value ?? '—'} to ${item.max_value ?? '—'}` : 'Enter observed value'} /></label> :
             item.input_type === 'boolean' ? <label>Result<select value={(answers[item.id] || emptyAnswer()).value} onChange={e => updateAnswer(item.id,'value',e.target.value)} required={item.is_required}><option value="">Select result</option><option value="true">Yes / Pass</option><option value="false">No / Fail</option></select></label> :
             item.input_type === 'status' ? <label>Condition<select value={(answers[item.id] || emptyAnswer()).value} onChange={e => updateAnswer(item.id,'value',e.target.value)} required={item.is_required}><option value="">Select condition</option><option value="normal">Normal</option><option value="attention">Needs attention</option><option value="abnormal">Abnormal</option><option value="not_applicable">Not applicable</option></select></label> :
             item.input_type === 'photo' ? <p className="form-warning">Photo-based checklist responses are not enabled yet. Ask an administrator to use a text, numeric, boolean, or status item until private checklist-photo upload is implemented.</p> :
             <label>Observation<input value={(answers[item.id] || emptyAnswer()).value} onChange={e => updateAnswer(item.id,'value',e.target.value)} required={item.is_required} maxLength={2000} placeholder="Enter observation" /></label>}
            <label>Remarks (optional)<textarea value={(answers[item.id] || emptyAnswer()).remarks} onChange={e => updateAnswer(item.id,'remarks',e.target.value)} rows={2} maxLength={2000} placeholder="Additional context" /></label>
            <label>Finding / abnormality (required if outside configured numeric range)<textarea value={(answers[item.id] || emptyAnswer()).finding} onChange={e => updateAnswer(item.id,'finding',e.target.value)} rows={2} maxLength={2000} placeholder="Describe any abnormal condition" /></label>
            <label>Corrective action<textarea value={(answers[item.id] || emptyAnswer()).correctiveAction} onChange={e => updateAnswer(item.id,'correctiveAction',e.target.value)} rows={2} maxLength={2000} placeholder="Action taken or follow-up required" /></label>
          </div>)}
          <div className="form-warning"><ShieldCheck size={17}/><span>Submissions are saved in PostgreSQL and audited. Submitted checklists are read-only in this first version and require supervisor review.</span></div>
          <button className="primary-button" disabled={busy || selectedItems.length === 0}><Send size={16}/> {busy ? 'Submitting…' : 'Submit shift checklist'}</button>
        </form>}
      {notice && <p className="form-notice">{notice}</p>}
    </section>
    <section className="panel config-list">
      <div className="panel-head"><div><h2>Recent submissions</h2><p>Stored checklist records and review status</p></div><button type="button" className="secondary-button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={14}/> Refresh</button></div>
      {submissions.length === 0 ? <p className="empty-state">No checklist submissions found.</p> : <div className="meter-table">{submissions.map(s => <div className="checklist-submission-row" key={s.id}><div><b>{s.template_name} · {s.shift_name}</b><small>{s.shift_date} · {s.submitted_by} · {s.response_count} responses{s.findings_count ? ` · ${s.findings_count} findings` : ''}</small></div><span className={`status-tag ${s.status==='approved'?'done-tag':s.status==='needs_action'?'review-tag':'pending-tag'}`}>{s.status.replace('_',' ')}</span>{['supervisor','admin'].includes(userRole) && s.status==='submitted' && <div className="checklist-review-actions"><button className="secondary-button" disabled={busy} onClick={() => void review(s.id,'approved')}><CheckCircle2 size={14}/> Approve</button><button className="secondary-button" disabled={busy} onClick={() => void review(s.id,'needs_action')}>Needs action</button></div>}</div>)}</div>}
    </section>
  </div>;
}
