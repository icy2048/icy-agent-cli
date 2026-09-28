import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Composer } from './Composer.js';
import { modelServices, type ModelProfile, type ModelServices } from '../config/models.js';
import { validateBaseUrl, type Config } from '../config/load.js';
import { clean, errorText, redact } from '../core/text.js';

type Step = 'source' | 'url' | 'key' | 'protocol' | 'models' | 'manual-model' | 'confirm' | 'testing' | 'saving';
export function ModelWizard({ config, width, onClose, onApply, services = modelServices }: {
  config: Config; width: number; onClose: () => void;
  onApply: (profile: ModelProfile) => Promise<void>; services?: ModelServices;
}) {
  const [step, setStep] = useState<Step>('source'), [index, setIndex] = useState(0);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]), [models, setModels] = useState<string[]>([]);
  const [draft, setDraft] = useState<ModelProfile>({ name: '自定义服务', baseUrl: '', apiKey: '', model: '', provider: 'chat-completions', allowPrivateHttp: config.allowPrivateHttp });
  const [input, setInput] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [discoveryNote, setDiscoveryNote] = useState('');
  const abort = useRef(new AbortController()), operation = useRef(false), listing = useRef<AbortController | undefined>(undefined);
  const current: ModelProfile = { name: '当前服务', baseUrl: config.baseUrl, provider: config.provider, model: config.model, apiKey: config.apiKey, reasoningEffort: config.reasoningEffort, reasoningSummary: config.reasoningSummary, allowPrivateHttp: config.allowPrivateHttp };
  useEffect(() => {
    void services.discover().then(p => { if (!abort.current.signal.aborted) setProfiles(p); }).catch(() => setDiscoveryNote('未能读取 CC Switch，可继续使用当前服务或手动配置。')).finally(() => setLoading(false));
    return () => abort.current.abort();
  }, []);
  const move = (next: Step) => { if (next !== 'models') { listing.current?.abort(); setLoading(false); } setStep(next); setIndex(0); setError(''); setInput(''); };
  const sources = [...(config.apiKey ? [current] : []), ...profiles];
  const options = step === 'source' ? [...sources.map(p => `${p.name}${p.name === '当前服务' ? '' : ' · CC Switch'}  ·  ${p.model || new URL(p.baseUrl).host}`), '手动配置兼容服务']
    : step === 'protocol' ? ['Chat Completions · 通用兼容接口', 'Responses · Codex / 推理模型接口']
    : step === 'models' ? [...models.filter(m => m.toLowerCase().includes(input.toLowerCase())), '手动输入模型名', '返回服务选择'] : [];
  const selected = Math.min(index, Math.max(0, options.length - 1));
  const pickProfile = async (profile: ModelProfile) => {
    listing.current?.abort();
    const request = new AbortController(); listing.current = request;
    const signal = AbortSignal.any([request.signal, abort.current.signal]);
    setDraft(profile); move('models'); setLoading(true); setModels(profile.model ? [profile.model] : []);
    try {
      const found = await services.list(profile, signal);
      if (!signal.aborted) setModels([...new Set([profile.model, ...found].filter(Boolean))]);
    } catch (e) { if (!signal.aborted) setError(redact(errorText(e), [profile.apiKey])); }
    finally { if (!signal.aborted) setLoading(false); }
  };
  const activate = async () => {
    if (operation.current) return;
    operation.current = true; move('testing');
    try {
      const result = await services.verify(draft, config, abort.current.signal);
      if (abort.current.signal.aborted) return;
      if (!result.ok) { setStep('confirm'); setError(result.message); return; }
      setStep('saving'); await onApply(draft);
    } catch (e) {
      if (!abort.current.signal.aborted) { setStep('confirm'); setError(redact(errorText(e), [draft.apiKey])); }
    } finally { operation.current = false; }
  };
  const select = () => {
    if (step === 'source') {
      if (selected < sources.length) void pickProfile(sources[selected]);
      else { setDraft({ name: '自定义服务', baseUrl: '', apiKey: '', model: '', provider: 'chat-completions', allowPrivateHttp: config.allowPrivateHttp }); move('url'); }
    } else if (step === 'protocol') { void pickProfile({ ...draft, provider: selected === 1 ? 'responses' : 'chat-completions' }); }
    else if (step === 'models') {
      if (selected === options.length - 1) move('source');
      else if (selected === options.length - 2) { move('manual-model'); setInput(input || draft.model); }
      else { setDraft({ ...draft, model: options[selected] }); move('confirm'); }
    } else if (step === 'confirm') void activate();
  };
  const submit = (value: string) => {
    try {
      if (step === 'url') { setDraft({ ...draft, baseUrl: validateBaseUrl(value.trim(), config.allowPrivateHttp) }); move('key'); }
      else if (step === 'key') { if (!value.trim()) throw new Error('请输入 API key。'); setDraft({ ...draft, apiKey: value.trim() }); move('protocol'); }
      else if (step === 'manual-model') { if (!value.trim()) throw new Error('请输入模型名。'); setDraft({ ...draft, model: value.trim() }); move('confirm'); }
      else if (step === 'models') select();
    } catch (e) { setError(errorText(e)); }
  };
  useInput((value, key) => {
    if ((key.escape || (key.ctrl && value === 'c')) && step !== 'saving') { abort.current.abort(); onClose(); return; }
    if (step === 'testing' || step === 'saving') return;
    if (key.upArrow) setIndex(i => (i - 1 + options.length) % Math.max(1, options.length));
    if (key.downArrow) setIndex(i => (i + 1) % Math.max(1, options.length));
    if (key.return && !['url', 'key', 'manual-model', 'models'].includes(step)) select();
  });
  const editing = ['url', 'key', 'manual-model', 'models'].includes(step);
  const label = step === 'url' ? 'API 地址（包含 /v1 等路径前缀）' : step === 'key' ? 'API key · 隐藏输入，保存到本机私有文件' : step === 'manual-model' ? '模型名' : '搜索模型';
  const start = Math.max(0, selected - 4), visible = options.slice(start, start + 6);
  return <Box flexDirection="column" paddingX={2} width={width}>
    <Text color="cyan" bold>模型设置</Text>
    <Text dimColor wrap="truncate-end">当前 {config.model || '未配置'} · {config.provider}</Text>
    <Text> </Text>
    {step === 'source' && <Text>选择服务 · 自动读取本机 CC Switch 配置</Text>}
    {step === 'source' && discoveryNote && <Text color="yellow">{discoveryNote}</Text>}
    {step === 'protocol' && <Text>选择接口协议</Text>}
    {step === 'models' && <Text dimColor wrap="truncate-end">{clean(draft.name)} · {clean(draft.baseUrl)}{loading ? ' · 正在获取模型…' : ''}</Text>}
    {editing && <Box flexDirection="column"><Text dimColor>{label}</Text><Box><Text color="cyan">› </Text><Composer key={step} value={input} onChange={v => { setInput(v); setIndex(0); }} onSubmit={submit} width={width - 8} secret={step === 'key'} placeholder={step === 'models' ? ' 输入名称筛选，或直接 ↑↓ 选择' : ' 输入后按 Enter'} /></Box></Box>}
    {visible.map((item, i) => <Text key={`${step}-${start + i}`} color={start + i === selected ? 'cyan' : undefined} bold={start + i === selected} wrap="truncate-end">{start + i === selected ? '❯' : ' '} {clean(item)}</Text>)}
    {options.length > 6 && <Text dimColor>{selected + 1} / {options.length} · ↑↓ 滚动</Text>}
    {step === 'confirm' && <Box flexDirection="column">
      <Text bold>{clean(draft.model)}</Text><Text>{clean(draft.baseUrl)}</Text><Text dimColor>{draft.provider} · 密钥已就绪</Text>
      <Text> </Text><Text>Enter 测试连接并启用</Text><Text dimColor>发送一次简短测试；通过后保存并开始新会话，旧会话保留。</Text>
    </Box>}
    {step === 'testing' && <Box flexDirection="column"><Text color="cyan">测试文本响应…</Text><Text color="cyan">测试工具调用…</Text><Text dimColor>正在测试连接… Esc 取消</Text></Box>}
    {step === 'saving' && <Box flexDirection="column"><Text color="green">连接测试通过：文本响应与工具调用正常</Text><Text color="cyan">正在保存并启用…</Text></Box>}
    {error && <Text color="yellow">{clean(error).slice(0, 300)}</Text>}
    <Text> </Text><Text dimColor>{step === 'source' && loading ? '正在读取本机配置… · ' : ''}↑↓ 选择 · Enter 确认 · Esc 关闭</Text>
  </Box>;
}
