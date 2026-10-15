/Users/buivannin/Desktop/workspace/personal/codex-server/codex_server_observability_dashboard.tsximport React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Activity,
  Terminal,
  Cpu,
  Database,
  DollarSign,
  Clock,
  Zap,
  AlertTriangle,
  Search,
  RefreshCw,
  Copy,
  Check,
  Plus,
  Trash2,
  Send,
  ChevronRight,
  ChevronDown,
  Layers,
  Video,
  MessageSquare,
  BarChart3,
  Radio,
  Sparkles,
  Sliders,
  Moon,
  Sun,
  ArrowUpRight,
  Filter,
  Eye,
  X,
  CheckCircle2,
  Code2,
  Server,
  HardDrive,
  Flame,
  TrendingUp,
  Info,
  Play,
  FileCode
} from 'lucide-react';

// ==========================================
// MOCK DATA (Chuẩn theo ảnh chụp thực tế của bạn)
// ==========================================
const PROJECTS_DATA = [
  {
    id: 'agent-corporation',
    name: 'agent-corporation',
    sessions: 2,
    calls: 7,
    totalTokens: 53729233,
    inputTokens: 53490120,
    cachedTokens: 52100400,
    outputTokens: 239113,
    avgPerCall: 7674319,
    cost: 3.096721,
    color: 'from-blue-500 to-indigo-500',
    badgeBg: 'bg-blue-500/10 text-blue-400 border-blue-500/20'
  },
  {
    id: 'codex-server',
    name: 'codex-server',
    sessions: 1,
    calls: 6,
    totalTokens: 27728537,
    inputTokens: 27550110,
    cachedTokens: 26890000,
    outputTokens: 178427,
    avgPerCall: 4621423,
    cost: 5.662781,
    color: 'from-emerald-500 to-teal-500',
    badgeBg: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
  },
  {
    id: 'mySeBrain',
    name: 'mySeBrain',
    sessions: 1,
    calls: 2,
    totalTokens: 4725737,
    inputTokens: 4701191,
    cachedTokens: 4491968,
    outputTokens: 15546,
    avgPerCall: 2362869,
    cost: 0.106155,
    color: 'from-amber-500 to-orange-500',
    badgeBg: 'bg-amber-500/10 text-amber-400 border-amber-500/20'
  }
];

const MODELS_DATA = [
  {
    id: 'gpt-6-luna',
    name: 'gpt-6-luna',
    tier: 'Flagship Reasoning',
    sessions: 2,
    calls: 8,
    totalTokens: 43714243,
    avgPerCall: 5464280,
    cost: 8.668319,
    cacheHitRate: 96.8,
    speed: '118 tok/s',
    color: 'bg-violet-500'
  },
  {
    id: 'gpt-5.4-mini',
    name: 'gpt-5.4-mini',
    tier: 'High-Speed Edge',
    sessions: 2,
    calls: 7,
    totalTokens: 42460264,
    avgPerCall: 6065752,
    cost: 0.197338,
    cacheHitRate: 98.1,
    speed: '245 tok/s',
    color: 'bg-cyan-500'
  }
];

const SESSIONS_DATA = [
  {
    id: 'sess_01J9X8K2M',
    project: 'codex-server',
    source: 'CLI / App',
    model: 'gpt-6-luna',
    reasoning: 'medium',
    turns: 6,
    totalTokens: 27728537,
    avgTokens: 4621423,
    cachedRatio: 96.9,
    durationSec: 3757.1,
    cost: 5.662781,
    lastActive: '4 phút trước',
    status: 'completed',
    turnBreakdown: [
      { turn: 1, input: 3120400, cached: 2980000, output: 24120, latency: '4.2s', cost: 0.621 },
      { turn: 2, input: 4150200, cached: 4010000, output: 31400, latency: '5.1s', cost: 0.842 },
      { turn: 3, input: 4590000, cached: 4480000, output: 29800, latency: '4.8s', cost: 0.912 },
      { turn: 4, input: 4920000, cached: 4810000, output: 35100, latency: '6.0s', cost: 1.024 },
      { turn: 5, input: 5280000, cached: 5190000, output: 28900, latency: '4.9s', cost: 1.089 },
      { turn: 6, input: 5489510, cached: 5420000, output: 29107, latency: '5.3s', cost: 1.174 }
    ]
  },
  {
    id: 'sess_01J9X7A9P',
    project: 'agent-corporation',
    source: 'CLI Worker',
    model: 'gpt-5.4-mini',
    reasoning: 'high',
    turns: 7,
    totalTokens: 53729233,
    avgTokens: 7674319,
    cachedRatio: 97.4,
    durationSec: 5940.0,
    cost: 3.096721,
    lastActive: '18 phút trước',
    status: 'completed',
    turnBreakdown: [
      { turn: 1, input: 6200100, cached: 5950000, output: 31000, latency: '2.8s', cost: 0.38 },
      { turn: 2, input: 7100400, cached: 6920000, output: 34200, latency: '3.1s', cost: 0.42 },
      { turn: 3, input: 7540000, cached: 7380000, output: 38900, latency: '3.4s', cost: 0.45 },
      { turn: 4, input: 7890000, cached: 7710000, output: 32100, latency: '2.9s', cost: 0.46 },
      { turn: 5, input: 8120000, cached: 7960000, output: 35400, latency: '3.2s', cost: 0.47 },
      { turn: 6, input: 8340000, cached: 8190000, output: 33100, latency: '3.0s', cost: 0.46 },
      { turn: 7, input: 8299620, cached: 7990400, output: 34413, latency: '3.1s', cost: 0.45 }
    ]
  },
  {
    id: 'sess_01J9X5M3L',
    project: 'mySeBrain',
    source: 'Local SDK',
    model: 'gpt-6-luna',
    reasoning: 'medium',
    turns: 2,
    totalTokens: 4725737,
    avgTokens: 2362869,
    cachedRatio: 95.5,
    durationSec: 488.7,
    cost: 0.106155,
    lastActive: '42 phút trước',
    status: 'spike_warning',
    turnBreakdown: [
      { turn: 1, input: 2150120, cached: 2040000, output: 6420, latency: '3.2s', cost: 0.042 },
      { turn: 2, input: 2551071, cached: 2451968, output: 9126, latency: '4.1s', cost: 0.064 }
    ]
  }
];

const LIVE_REQUESTS = [
  { id: 'req_9921a', time: '13:37:02', project: 'codex-server', model: 'gpt-6-luna', status: 200, input: 5489510, cached: 5420000, output: 29107, ttft: '190ms', duration: '5.3s', cost: '$1.174' },
  { id: 'req_9920f', time: '13:34:18', project: 'agent-corporation', model: 'gpt-5.4-mini', status: 200, input: 8299620, cached: 7990400, output: 34413, ttft: '110ms', duration: '3.1s', cost: '$0.451' },
  { id: 'req_9919c', time: '13:29:45', project: 'mySeBrain', model: 'gpt-6-luna', status: 200, input: 210564, cached: 72642, output: 4820, ttft: '240ms', duration: '4.1s', cost: '$0.064', spike: true },
  { id: 'req_9918b', time: '13:24:10', project: 'codex-server', model: 'gpt-6-luna', status: 200, input: 5280000, cached: 5190000, output: 28900, ttft: '185ms', duration: '4.9s', cost: '$1.089' },
  { id: 'req_9917e', time: '13:19:04', project: 'agent-corporation', model: 'gpt-5.4-mini', status: 200, input: 8340000, cached: 8190000, output: 33100, ttft: '105ms', duration: '3.0s', cost: '$0.460' }
];

const MODEL_PRICING = [
  { model: 'gpt-6-luna', provider: 'OpenAI / Local Proxy', contextWindow: '2,000,000', inputPrice: '$2.50 / 1M', cachedPrice: '$0.125 / 1M (-95%)', outputPrice: '$10.00 / 1M', reasoningSupport: 'Low / Medium / High', status: 'Active Default' },
  { model: 'gpt-5.4-mini', provider: 'OpenAI / Local Proxy', contextWindow: '1,000,000', inputPrice: '$0.15 / 1M', cachedPrice: '$0.015 / 1M (-90%)', outputPrice: '$0.60 / 1M', reasoningSupport: 'Low / Medium / High', status: 'Active' },
  { model: 'claude-4.5-sonnet', provider: 'Anthropic Bridge', contextWindow: '500,000', inputPrice: '$3.00 / 1M', cachedPrice: '$0.30 / 1M (-90%)', outputPrice: '$15.00 / 1M', reasoningSupport: 'Extended Thinking', status: 'Standby' }
];

const VIDEO_BUILDS = [
  { id: 'vid_build_884', project: 'agent-corporation', title: 'Automated Product Demo Render #14', resolution: '1080p @ 60fps', frames: 3600, duration: '60s', status: 'Completed', renderTime: '42.4s', cost: '$0.18' },
  { id: 'vid_build_883', project: 'mySeBrain', title: 'Knowledge Graph Walkthrough', resolution: '4K @ 30fps', frames: 1800, duration: '60s', status: 'Rendering (78%)', renderTime: '1m 12s', cost: '$0.31' },
  { id: 'vid_build_882', project: 'codex-server', title: 'Telemetry Weekly Digest Clip', resolution: '1080p @ 60fps', frames: 1440, duration: '24s', status: 'Completed', renderTime: '18.9s', cost: '$0.08' }
];

// ==========================================
// HELPER FORMATTERS
// ==========================================
const formatNumber = (num) => {
  if (num === undefined || num === null) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};

const formatCompactVN = (num) => {
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(2).replace('.', ',') + ' Tr';
  }
  if (num >= 1_000) {
    return formatNumber(num);
  }
  return num.toString();
};

const formatCost = (cost) => {
  return '$' + cost.toFixed(6);
};

// ==========================================
// MAIN APPLICATION COMPONENT
// ==========================================
export default function App() {
  // Navigation & Theme State
  const [activeTab, setActiveTab] = useState('codex-usage'); // 'thong-ke' | 'request-truc-tiep' | 'codex-usage' | 'video-builds' | 'test-chat' | 'model-gia'
  const [darkMode, setDarkMode] = useState(true);

  // Filters State (for Codex Usage)
  const [timePreset, setTimePreset] = useState('today'); // '7d' | '30d' | '90d' | 'all' | 'today'
  const [selectedSource, setSelectedSource] = useState('all');
  const [selectedProject, setSelectedProject] = useState('all');
  const [selectedModel, setSelectedModel] = useState('all');
  const [granularity, setGranularity] = useState('day');
  const [sessionSearch, setSessionSearch] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [countdown, setCountdown] = useState(30);

  // Slide-over Drawer for Session Inspection
  const [inspectedSession, setInspectedSession] = useState(null);

  // Toast Notification State
  const [toast, setToast] = useState(null);

  // ==========================================
  // TEST CHAT STATE (Tab 5)
  // ==========================================
  const [chatTabs, setChatTabs] = useState([
    {
      id: 'chat-1',
      title: 'Chat 1',
      model: 'gpt-6-luna',
      reasoning: 'medium',
      systemPrompt: 'Bạn là trợ lý kỹ thuật chạy trên Codex Server local. Trả lời ngắn gọn, chính xác, ưu tiên định dạng Markdown và phân tích rõ hiệu năng.',
      showSystemPrompt: false,
      messages: []
    }
  ]);
  const [activeChatTabId, setActiveChatTabId] = useState('chat-1');
  const [chatInput, setChatInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [copiedModel, setCopiedModel] = useState(false);
  const chatEndRef = useRef(null);

  const activeChatTab = useMemo(
    () => chatTabs.find((t) => t.id === activeChatTabId) || chatTabs[0],
    [chatTabs, activeChatTabId]
  );

  // Trigger Toast Helper
  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 2800);
  };

  // Auto-refresh countdown timer
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? 30 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleManualRefresh = () => {
    setIsRefreshing(true);
    setCountdown(30);
    setTimeout(() => {
      setIsRefreshing(false);
      showToast('Đã đồng bộ dữ liệu telemetry mới nhất từ Codex Server');
    }, 550);
  };

  // Filtered Projects & Sessions
  const filteredProjects = useMemo(() => {
    if (selectedProject === 'all') return PROJECTS_DATA;
    return PROJECTS_DATA.filter((p) => p.id === selectedProject);
  }, [selectedProject]);

  const filteredSessions = useMemo(() => {
    return SESSIONS_DATA.filter((s) => {
      const matchProject = selectedProject === 'all' || s.project === selectedProject;
      const matchModel = selectedModel === 'all' || s.model === selectedModel;
      const matchSearch =
        !sessionSearch.trim() ||
        s.project.toLowerCase().includes(sessionSearch.toLowerCase()) ||
        s.model.toLowerCase().includes(sessionSearch.toLowerCase()) ||
        s.id.toLowerCase().includes(sessionSearch.toLowerCase());
      return matchProject && matchModel && matchSearch;
    });
  }, [selectedProject, selectedModel, sessionSearch]);

  // Dynamic Aggregated KPIs based on filters
  const aggregatedKPIs = useMemo(() => {
    const totalSessions = filteredSessions.length;
    const totalCalls = filteredSessions.reduce((acc, s) => acc + s.turns, 0);
    const totalTokens = filteredProjects.reduce((acc, p) => acc + p.totalTokens, 0);
    const inputTokens = filteredProjects.reduce((acc, p) => acc + p.inputTokens, 0);
    const cachedTokens = filteredProjects.reduce((acc, p) => acc + p.cachedTokens, 0);
    const outputTokens = filteredProjects.reduce((acc, p) => acc + p.outputTokens, 0);
    const totalCost = filteredProjects.reduce((acc, p) => acc + p.cost, 0);
    const cacheRate = inputTokens > 0 ? ((cachedTokens / inputTokens) * 100).toFixed(1) : '0.0';

    return {
      totalSessions,
      totalCalls,
      totalTokens,
      inputTokens,
      cachedTokens,
      outputTokens,
      totalCost,
      cacheRate
    };
  }, [filteredProjects, filteredSessions]);

  // ==========================================
  // TEST CHAT HANDLERS
  // ==========================================
  const updateActiveChatTab = (patch) => {
    setChatTabs((prev) =>
      prev.map((tab) => (tab.id === activeChatTab.id ? { ...tab, ...patch } : tab))
    );
  };

  const handleAddChatTab = () => {
    const nextNum = chatTabs.length + 1;
    const newId = `chat-${Date.now()}`;
    const newTab = {
      id: newId,
      title: `Chat ${nextNum}`,
      model: 'gpt-6-luna',
      reasoning: 'medium',
      systemPrompt: '',
      showSystemPrompt: false,
      messages: []
    };
    setChatTabs((prev) => [...prev, newTab]);
    setActiveChatTabId(newId);
    showToast(`Đã tạo phiên ${newTab.title} trong bộ nhớ`);
  };

  const handleDeleteChatTab = (idToRemove) => {
    if (chatTabs.length <= 1) {
      // Clear current tab messages instead of deleting the last tab
      updateActiveChatTab({ messages: [] });
      showToast('Đã làm sạch context của tab hiện tại');
      return;
    }
    const remaining = chatTabs.filter((t) => t.id !== idToRemove);
    setChatTabs(remaining);
    if (activeChatTabId === idToRemove) {
      setActiveChatTabId(remaining[remaining.length - 1].id);
    }
    showToast('Đã xóa tab test chat');
  };

  const handleCopyModel = () => {
    navigator.clipboard?.writeText(activeChatTab.model);
    setCopiedModel(true);
    showToast(`Đã sao chép tên model: ${activeChatTab.model}`);
    setTimeout(() => setCopiedModel(false), 1800);
  };

  const handleSendTestMessage = (customPrompt) => {
    const contentToSend = typeof customPrompt === 'string' ? customPrompt : chatInput.trim();
    if (!contentToSend || isStreaming) return;

    const userMsg = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: contentToSend,
      timestamp: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };

    const currentMessages = [...activeChatTab.messages, userMsg];
    updateActiveChatTab({ messages: currentMessages });
    setChatInput('');
    setIsStreaming(true);

    // Simulate realistic Codex Server streaming response with telemetry
    setTimeout(() => {
      const reasoningMultiplier = activeChatTab.reasoning === 'high' ? 640 : activeChatTab.reasoning === 'medium' ? 320 : 90;
      const simulatedResponse = {
        id: `msg-${Date.now() + 1}`,
        role: 'assistant',
        model: activeChatTab.model,
        reasoning: activeChatTab.reasoning,
        timestamp: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        content: `Đã nhận request trên **Codex Server** với model \`${activeChatTab.model}\` (mức suy luận: \`${activeChatTab.reasoning}\`).\n\n### Kết quả kiểm tra đường truyền & Context:\n- **Trạng thái KV Cache:** Khớp \`97.4%\` prefix từ bộ nhớ phiên hiện tại (${currentMessages.length} lượt tin nhắn).\n- **Phản hồi cho yêu cầu:** "${contentToSend}"\n\n\`\`\`json\n{\n  "server": "codex-server-local",\n  "model": "${activeChatTab.model}",\n  "reasoning_effort": "${activeChatTab.reasoning}",\n  "context_in_memory": true,\n  "status": "healthy"\n}\n\`\`\``,
        telemetry: {
          ttft: activeChatTab.model === 'gpt-5.4-mini' ? '112ms' : '184ms',
          reasoningTokens: reasoningMultiplier,
          inputTokens: 1240 + currentMessages.length * 480,
          cachedTokens: currentMessages.length > 1 ? 1180 + (currentMessages.length - 1) * 450 : 0,
          outputTokens: 148,
          speed: activeChatTab.model === 'gpt-5.4-mini' ? '238 tok/s' : '124 tok/s',
          cost: activeChatTab.model === 'gpt-5.4-mini' ? '$0.00019' : '$0.00184'
        }
      };

      updateActiveChatTab({ messages: [...currentMessages, simulatedResponse] });
      setIsStreaming(false);
      setTimeout(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }, 650);
  };

  // ==========================================
  // NAVIGATION TABS DEFINITION
  // ==========================================
  const TABS = [
    { id: 'thong-ke', label: 'Thống kê', icon: BarChart3 },
    { id: 'request-truc-tiep', label: 'Request trực tiếp', icon: Radio, liveDot: true },
    { id: 'codex-usage', label: 'Codex usage', icon: Cpu, badge: '86,17 Tr' },
    { id: 'video-builds', label: 'Video builds', icon: Video },
    { id: 'test-chat', label: 'Test chat', icon: MessageSquare, badge: `${chatTabs.length} tab` },
    { id: 'model-gia', label: 'Model & giá', icon: DollarSign }
  ];

  return (
    <div
      className={`min-h-screen transition-colors duration-300 font-sans selection:bg-indigo-500/30 ${
        darkMode
          ? 'bg-[#090B10] text-slate-100'
          : 'bg-[#F4F6FA] text-slate-900'
      }`}
    >
      {/* Subtle Ambient Background Glow */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div
          className={`absolute -top-40 left-1/4 w-[550px] h-[320px] rounded-full blur-[130px] transition-opacity duration-500 ${
            darkMode ? 'bg-indigo-600/12 opacity-100' : 'bg-indigo-400/15 opacity-70'
          }`}
        />
        <div
          className={`absolute top-20 right-1/4 w-[450px] h-[280px] rounded-full blur-[130px] transition-opacity duration-500 ${
            darkMode ? 'bg-emerald-600/10 opacity-100' : 'bg-emerald-400/15 opacity-60'
          }`}
        />
      </div>

      {/* Floating Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-2xl border backdrop-blur-xl animate-bounce bg-slate-900/95 border-indigo-500/40 text-white text-sm">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toast.message}</span>
        </div>
      )}

      {/* ========================================== */}
      {/* TOP HEADER & GLOBAL TELEMETRY BAR          */}
      {/* ========================================== */}
      <header
        className={`sticky top-0 z-30 backdrop-blur-xl border-b transition-colors ${
          darkMode
            ? 'bg-[#090B10]/85 border-slate-800/80'
            : 'bg-white/85 border-slate-200/90 shadow-xs'
        }`}
      >
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-3.5">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            {/* Brand & Title */}
            <div className="flex items-start sm:items-center gap-3.5">
              <div className="relative flex items-center justify-center w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-700 text-white shadow-lg shadow-indigo-500/25 shrink-0">
                <Terminal className="w-5 h-5" />
                <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 ring-2 ring-[#090B10]" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-mono uppercase tracking-widest px-2 py-0.5 rounded-md font-semibold bg-indigo-500/15 text-indigo-400 border border-indigo-500/25">
                    Codex Server
                  </span>
                  <span
                    className={`text-[11px] font-mono uppercase tracking-wider ${
                      darkMode ? 'text-slate-400' : 'text-slate-500'
                    }`}
                  >
                    • SERVER OBSERVABILITY
                  </span>
                </div>
                <div className="flex items-baseline gap-3 mt-0.5">
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight">
                    Hoạt động server
                  </h1>
                  <p
                    className={`hidden md:block text-xs ${
                      darkMode ? 'text-slate-400' : 'text-slate-500'
                    }`}
                  >
                    Call, token, chi phí và thời gian xử lý. Tất cả trong một góc nhìn.
                  </p>
                </div>
              </div>
            </div>

            {/* Right Status Cluster */}
            <div className="flex flex-wrap items-center gap-2.5">
              {/* Server Active Status Pill */}
              <div
                className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-medium ${
                  darkMode
                    ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300'
                    : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                }`}
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span>Server đang hoạt động</span>
              </div>

              {/* Active Runtime Model Badge */}
              <div
                className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs ${
                  darkMode
                    ? 'bg-slate-900/90 border-slate-800 text-slate-300'
                    : 'bg-slate-100 border-slate-200 text-slate-700'
                }`}
              >
                <Cpu className="w-3.5 h-3.5 text-violet-400" />
                <span className="font-mono font-semibold text-violet-400">gpt-6-luna</span>
                <span className={darkMode ? 'text-slate-600' : 'text-slate-300'}>|</span>
                <span className="hidden sm:inline text-[11px] opacity-80">
                  medium reasoning · uptime 17m
                </span>
              </div>

              {/* Auto-refresh indicator */}
              <button
                onClick={handleManualRefresh}
                title="Làm mới ngay lập tức"
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium transition-all active:scale-95 ${
                  darkMode
                    ? 'bg-slate-900/90 border-slate-800 hover:border-slate-700 text-slate-300'
                    : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-700'
                }`}
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 text-indigo-400 ${
                    isRefreshing ? 'animate-spin' : ''
                  }`}
                />
                <span className="font-mono text-[11px]">{countdown}s</span>
              </button>

              {/* Theme Toggle */}
              <button
                onClick={() => setDarkMode(!darkMode)}
                className={`p-2 rounded-xl border transition-all ${
                  darkMode
                    ? 'bg-slate-900/90 border-slate-800 hover:border-slate-700 text-amber-400'
                    : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-700'
                }`}
                title="Chuyển đổi giao diện Sáng / Tối"
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* ========================================== */}
          {/* NAVIGATION TABS                            */}
          {/* ========================================== */}
          <div className="flex items-center gap-1.5 mt-4 overflow-x-auto no-scrollbar pb-1">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`group relative flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-medium transition-all whitespace-nowrap ${
                    isActive
                      ? darkMode
                        ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 shadow-sm'
                        : 'bg-indigo-600 text-white shadow-sm'
                      : darkMode
                      ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60 border border-transparent'
                  }`}
                >
                  <Icon
                    className={`w-4 h-4 transition-transform group-hover:scale-110 ${
                      isActive
                        ? darkMode
                          ? 'text-indigo-400'
                          : 'text-white'
                        : 'opacity-70'
                    }`}
                  />
                  <span>{tab.label}</span>
                  {tab.liveDot && (
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  )}
                  {tab.badge && (
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md ${
                        isActive
                          ? darkMode
                            ? 'bg-indigo-500/30 text-indigo-200'
                            : 'bg-white/20 text-white'
                          : darkMode
                          ? 'bg-slate-800 text-slate-400'
                          : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* ========================================== */}
      {/* MAIN CONTENT CONTAINER                     */}
      {/* ========================================== */}
      <main className="relative z-10 max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* ===================================================================== */}
        {/* TAB 3: CODEX USAGE (BẢN THIẾT KẾ LẠI TRANG ĐẦU TIÊN CỦA BẠN)          */}
        {/* ===================================================================== */}
        {activeTab === 'codex-usage' && (
          <div className="space-y-6">
            {/* Section Title & Filter Bar Card */}
            <div
              className={`p-4 sm:p-5 rounded-2xl border transition-all ${
                darkMode
                  ? 'bg-[#11141D]/90 border-slate-800/80 shadow-xl shadow-black/20'
                  : 'bg-white border-slate-200/90 shadow-sm'
              }`}
            >
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800/60">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold tracking-tight">
                      Codex usage trên laptop
                    </h2>
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      Local Telemetry
                    </span>
                  </div>
                  <p
                    className={`text-xs mt-0.5 ${
                      darkMode ? 'text-slate-400' : 'text-slate-500'
                    }`}
                  >
                    Theo dõi lượng token tiêu thụ, tỷ lệ trúng bộ nhớ đệm (Cached Token) và quy đổi chi phí API tương đương.
                  </p>
                </div>

                {/* Quick Time Range Pills */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {[
                    { id: '7d', label: '7 ngày' },
                    { id: '30d', label: '30 ngày' },
                    { id: '90d', label: '90 ngày' },
                    { id: 'all', label: 'Tất cả' },
                    { id: 'today', label: 'Hôm nay từ 0h' }
                  ].map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => setTimePreset(preset.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        timePreset === preset.id
                          ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/30'
                          : darkMode
                          ? 'bg-slate-800/70 text-slate-300 hover:bg-slate-800'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Filter Dropdowns Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-4">
                {/* Khoảng thời gian */}
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-wider opacity-60 mb-1">
                    Khoảng thời gian
                  </label>
                  <select
                    value={timePreset}
                    onChange={(e) => setTimePreset(e.target.value)}
                    className={`w-full px-3 py-2 rounded-xl border text-xs font-medium outline-none transition-colors ${
                      darkMode
                        ? 'bg-slate-900/90 border-slate-800 text-slate-200 focus:border-indigo-500'
                        : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-indigo-500'
                    }`}
                  >
                    <option value="today">Hôm nay từ 0h (15/10/2026)</option>
                    <option value="7d">7 ngày gần nhất</option>
                    <option value="30d">30 ngày gần nhất</option>
                    <option value="90d">90 ngày gần nhất</option>
                    <option value="all">Toàn bộ lịch sử</option>
                  </select>
                </div>

                {/* Nguồn */}
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-wider opacity-60 mb-1">
                    Nguồn
                  </label>
                  <select
                    value={selectedSource}
                    onChange={(e) => setSelectedSource(e.target.value)}
                    className={`w-full px-3 py-2 rounded-xl border text-xs font-medium outline-none transition-colors ${
                      darkMode
                        ? 'bg-slate-900/90 border-slate-800 text-slate-200 focus:border-indigo-500'
                        : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-indigo-500'
                    }`}
                  >
                    <option value="all">Tất cả nguồn (CLI + App + SDK)</option>
                    <option value="cli">Codex CLI</option>
                    <option value="app">Desktop App</option>
                  </select>
                </div>

                {/* Project */}
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-wider opacity-60 mb-1">
                    Project
                  </label>
                  <select
                    value={selectedProject}
                    onChange={(e) => setSelectedProject(e.target.value)}
                    className={`w-full px-3 py-2 rounded-xl border text-xs font-medium outline-none transition-colors ${
                      darkMode
                        ? 'bg-slate-900/90 border-slate-800 text-slate-200 focus:border-indigo-500'
                        : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-indigo-500'
                    }`}
                  >
                    <option value="all">Tất cả project (3)</option>
                    <option value="agent-corporation">agent-corporation</option>
                    <option value="codex-server">codex-server</option>
                    <option value="mySeBrain">mySeBrain</option>
                  </select>
                </div>

                {/* Model */}
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-wider opacity-60 mb-1">
                    Model
                  </label>
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className={`w-full px-3 py-2 rounded-xl border text-xs font-medium outline-none transition-colors ${
                      darkMode
                        ? 'bg-slate-900/90 border-slate-800 text-slate-200 focus:border-indigo-500'
                        : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-indigo-500'
                    }`}
                  >
                    <option value="all">Tất cả model (2)</option>
                    <option value="gpt-6-luna">gpt-6-luna</option>
                    <option value="gpt-5.4-mini">gpt-5.4-mini</option>
                  </select>
                </div>

                {/* Nhóm theo */}
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-wider opacity-60 mb-1">
                    Nhóm theo
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={granularity}
                      onChange={(e) => setGranularity(e.target.value)}
                      className={`w-full px-3 py-2 rounded-xl border text-xs font-medium outline-none transition-colors ${
                        darkMode
                          ? 'bg-slate-900/90 border-slate-800 text-slate-200 focus:border-indigo-500'
                          : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-indigo-500'
                      }`}
                    >
                      <option value="day">Ngày</option>
                      <option value="hour">Giờ</option>
                    </select>
                    {selectedProject !== 'all' || selectedModel !== 'all' ? (
                      <button
                        onClick={() => {
                          setSelectedProject('all');
                          setSelectedModel('all');
                        }}
                        className="px-3 py-2 rounded-xl bg-rose-500/15 text-rose-400 border border-rose-500/30 text-xs font-medium whitespace-nowrap hover:bg-rose-500/25"
                      >
                        Xóa lọc
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            {/* ========================================== */}
            {/* 6 KPI BENTO CARDS                          */}
            {/* ========================================== */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
              {/* 1. Sessions */}
              <div
                className={`p-4 rounded-2xl border transition-all hover:-translate-y-0.5 ${
                  darkMode
                    ? 'bg-[#11141D]/90 border-slate-800/80 hover:border-slate-700'
                    : 'bg-white border-slate-200/90 shadow-xs'
                }`}
              >
                <div className="flex items-center justify-between text-xs opacity-70 mb-2">
                  <span>Sessions</span>
                  <Layers className="w-4 h-4 text-indigo-400" />
                </div>
                <div className="text-2xl font-bold font-mono tracking-tight">
                  {aggregatedKPIs.totalSessions}
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-[11px] opacity-75">
                  <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 font-mono">
                    {filteredProjects.length} project
                  </span>
                  <span>• {aggregatedKPIs.totalCalls} lượt gọi</span>
                </div>
              </div>

              {/* 2. Tổng token */}
              <div
                className={`p-4 rounded-2xl border transition-all hover:-translate-y-0.5 ${
                  darkMode
                    ? 'bg-[#11141D]/90 border-slate-800/80 hover:border-slate-700'
                    : 'bg-white border-slate-200/90 shadow-xs'
                }`}
              >
                <div className="flex items-center justify-between text-xs opacity-70 mb-2">
                  <span>Tổng token</span>
                  <Database className="w-4 h-4 text-blue-400" />
                </div>
                <div className="text-2xl font-bold font-mono tracking-tight">
                  {formatCompactVN(aggregatedKPIs.totalTokens)}
                </div>
                <div className="mt-2 text-[11px] font-mono opacity-60 truncate">
                  {formatNumber(aggregatedKPIs.totalTokens)} tok
                </div>
              </div>

              {/* 3. Input token */}
              <div
                className={`p-4 rounded-2xl border transition-all hover:-translate-y-0.5 ${
                  darkMode
                    ? 'bg-[#11141D]/90 border-slate-800/80 hover:border-slate-700'
                    : 'bg-white border-slate-200/90 shadow-xs'
                }`}
              >
                <div className="flex items-center justify-between text-xs opacity-70 mb-2">
                  <span>Input token</span>
                  <ArrowUpRight className="w-4 h-4 text-sky-400" />
                </div>
                <div className="text-2xl font-bold font-mono tracking-tight">
                  {formatCompactVN(aggregatedKPIs.inputTokens)}
                </div>
                <div className="mt-2 text-[11px] font-mono opacity-60 truncate">
                  {formatNumber(aggregatedKPIs.inputTokens)} tok
                </div>
              </div>

              {/* 4. Cached token (Highlighted Cache Efficiency) */}
              <div
                className={`p-4 rounded-2xl border transition-all hover:-translate-y-0.5 ${
                  darkMode
                    ? 'bg-gradient-to-br from-emerald-950/35 to-[#11141D] border-emerald-500/30'
                    : 'bg-emerald-50/60 border-emerald-200'
                }`}
              >
                <div className="flex items-center justify-between text-xs mb-2">
                  <span className="font-medium text-emerald-400">Cached token</span>
                  <Zap className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="text-2xl font-bold font-mono tracking-tight text-emerald-400">
                  {formatCompactVN(aggregatedKPIs.cachedTokens)}
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px]">
                  <span className="font-mono text-emerald-400 font-semibold">
                    {aggregatedKPIs.cacheRate}% hit
                  </span>
                  <div className="w-16 h-1.5 rounded-full bg-emerald-950 overflow-hidden">
                    <div
                      className="h-full bg-emerald-400 rounded-full"
                      style={{ width: `${aggregatedKPIs.cacheRate}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* 5. Output token */}
              <div
                className={`p-4 rounded-2xl border transition-all hover:-translate-y-0.5 ${
                  darkMode
                    ? 'bg-[#11141D]/90 border-slate-800/80 hover:border-slate-700'
                    : 'bg-white border-slate-200/90 shadow-xs'
                }`}
              >
                <div className="flex items-center justify-between text-xs opacity-70 mb-2">
                  <span>Output token</span>
                  <Sparkles className="w-4 h-4 text-violet-400" />
                </div>
                <div className="text-2xl font-bold font-mono tracking-tight">
                  {formatNumber(aggregatedKPIs.outputTokens)}
                </div>
                <div className="mt-2 text-[11px] opacity-65">
                  Reasoning + Chuỗi phản hồi
                </div>
              </div>

              {/* 6. API Equivalent Cost */}
              <div
                className={`p-4 rounded-2xl border transition-all hover:-translate-y-0.5 ${
                  darkMode
                    ? 'bg-gradient-to-br from-amber-950/25 to-[#11141D] border-amber-500/30'
                    : 'bg-amber-50/60 border-amber-200'
                }`}
              >
                <div className="flex items-center justify-between text-xs mb-2">
                  <span className="font-medium text-amber-400">API equivalent</span>
                  <DollarSign className="w-4 h-4 text-amber-400" />
                </div>
                <div className="text-2xl font-bold font-mono tracking-tight text-amber-400">
                  {formatCost(aggregatedKPIs.totalCost)}
                </div>
                <div className="mt-2 text-[11px] opacity-75">
                  Tiết kiệm ~91% nhờ Cache
                </div>
              </div>
            </div>

            {/* ========================================== */}
            {/* CONTEXT SPIKES ANOMALY DETECTOR            */}
            {/* ========================================== */}
            <div
              className={`p-5 rounded-2xl border relative overflow-hidden ${
                darkMode
                  ? 'bg-gradient-to-r from-amber-500/10 via-[#11141D] to-[#11141D] border-amber-500/30'
                  : 'bg-gradient-to-r from-amber-50 via-white to-white border-amber-300'
              }`}
            >
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="flex items-start gap-3.5">
                  <div className="p-2.5 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0 mt-0.5">
                    <Flame className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm sm:text-base font-bold">
                        Context spikes phát hiện bất thường
                      </h3>
                      <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                        1 phiên tăng đột biến
                      </span>
                    </div>
                    <p
                      className={`text-xs mt-1 ${
                        darkMode ? 'text-slate-400' : 'text-slate-600'
                      }`}
                    >
                      Hiển thị các phiên có mức tăng trưởng context đột biến gần nhất trong khoảng lọc để tối ưu hóa kích thước prompt.
                    </p>
                  </div>
                </div>

                {/* Spike Detail Pill Card */}
                <div
                  className={`flex flex-wrap sm:flex-nowrap items-center gap-4 p-3.5 rounded-xl border ${
                    darkMode
                      ? 'bg-slate-950/80 border-slate-800'
                      : 'bg-slate-50 border-slate-200'
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-xs text-amber-400">
                        mySeBrain
                      </span>
                      <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">
                        gpt-6-luna
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1.5 font-mono text-xs">
                      <span className="opacity-60">63.534</span>
                      <ChevronRight className="w-3 h-3 opacity-40" />
                      <span className="opacity-80">72.642</span>
                      <ChevronRight className="w-3 h-3 text-amber-400" />
                      <span className="font-bold text-amber-400">210.564 tok</span>
                    </div>
                  </div>

                  {/* Mini Visual Step Bars */}
                  <div className="flex items-end gap-1 h-9 px-2">
                    <div className="w-2.5 h-3 rounded-t bg-slate-600" title="Turn 1: 63.5K" />
                    <div className="w-2.5 h-4 rounded-t bg-slate-500" title="Turn 2: 72.6K" />
                    <div className="w-2.5 h-9 rounded-t bg-amber-400 animate-pulse" title="Turn 3: 210.5K (+2.9x)" />
                  </div>

                  <div className="text-right font-mono">
                    <div className="text-xs font-bold text-rose-400">+2.9x spike</div>
                    <div className="text-[11px] opacity-60">Δ +137.922 tok</div>
                  </div>

                  <button
                    onClick={() => setInspectedSession(SESSIONS_DATA[2])}
                    className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-xs font-medium transition-colors"
                  >
                    Kiểm tra
                  </button>
                </div>
              </div>
            </div>

            {/* ========================================== */}
            {/* BREAKDOWN: THEO PROJECT & THEO MODEL       */}
            {/* ========================================== */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Theo Project */}
              <div
                className={`p-5 rounded-2xl border flex flex-col justify-between ${
                  darkMode
                    ? 'bg-[#11141D]/90 border-slate-800/80'
                    : 'bg-white border-slate-200/90 shadow-xs'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-base font-bold">Theo project</h3>
                      <p className="text-xs opacity-60">
                        Phân bổ token và chi phí theo từng repository / dự án
                      </p>
                    </div>
                    <span className="text-xs font-mono opacity-60">
                      Click để lọc nhanh
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr
                          className={`border-b text-[11px] font-mono uppercase opacity-60 ${
                            darkMode ? 'border-slate-800' : 'border-slate-200'
                          }`}
                        >
                          <th className="pb-2.5 font-medium">Project</th>
                          <th className="pb-2.5 font-medium text-right">Sessions</th>
                          <th className="pb-2.5 font-medium text-right">Tổng token</th>
                          <th className="pb-2.5 font-medium text-right">TB / lượt</th>
                          <th className="pb-2.5 font-medium text-right">API Cost</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/40 text-xs">
                        {PROJECTS_DATA.map((proj) => {
                          const sharePercent = (
                            (proj.totalTokens / 86174507) *
                            100
                          ).toFixed(1);
                          const isSelected = selectedProject === proj.id;
                          return (
                            <tr
                              key={proj.id}
                              onClick={() =>
                                setSelectedProject(isSelected ? 'all' : proj.id)
                              }
                              className={`group cursor-pointer transition-colors ${
                                isSelected
                                  ? 'bg-indigo-500/10'
                                  : darkMode
                                  ? 'hover:bg-slate-800/40'
                                  : 'hover:bg-slate-50'
                              }`}
                            >
                              <td className="py-3.5 pr-2">
                                <div className="flex items-center gap-2">
                                  <span
                                    className={`font-mono font-semibold px-2 py-0.5 rounded border ${proj.badgeBg}`}
                                  >
                                    {proj.name}
                                  </span>
                                </div>
                                <div className="w-32 h-1 rounded-full bg-slate-800 mt-1.5 overflow-hidden">
                                  <div
                                    className={`h-full bg-gradient-to-r ${proj.color}`}
                                    style={{ width: `${sharePercent}%` }}
                                  />
                                </div>
                              </td>
                              <td className="py-3.5 text-right font-mono">
                                {proj.sessions}
                              </td>
                              <td className="py-3.5 text-right font-mono font-semibold">
                                {formatNumber(proj.totalTokens)}
                              </td>
                              <td className="py-3.5 text-right font-mono opacity-75">
                                {formatNumber(proj.avgPerCall)}
                              </td>
                              <td className="py-3.5 text-right font-mono text-amber-400 font-semibold">
                                {formatCost(proj.cost)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div
                  className={`mt-4 pt-3 border-t flex items-center justify-between text-xs ${
                    darkMode ? 'border-slate-800/70 text-slate-400' : 'border-slate-100 text-slate-500'
                  }`}
                >
                  <span>Tổng cộng 3 dự án đang hoạt động</span>
                  <span className="font-mono font-semibold text-emerald-400">
                    86.174.507 tokens
                  </span>
                </div>
              </div>

              {/* Theo Model */}
              <div
                className={`p-5 rounded-2xl border flex flex-col justify-between ${
                  darkMode
                    ? 'bg-[#11141D]/90 border-slate-800/80'
                    : 'bg-white border-slate-200/90 shadow-xs'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-base font-bold">Theo model</h3>
                      <p className="text-xs opacity-60">
                        Hiệu suất sử dụng và chi phí quy đổi theo từng dòng mô hình
                      </p>
                    </div>
                    <span className="text-xs font-mono opacity-60">
                      2 active engines
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr
                          className={`border-b text-[11px] font-mono uppercase opacity-60 ${
                            darkMode ? 'border-slate-800' : 'border-slate-200'
                          }`}
                        >
                          <th className="pb-2.5 font-medium">Model</th>
                          <th className="pb-2.5 font-medium text-right">Sessions</th>
                          <th className="pb-2.5 font-medium text-right">Tổng token</th>
                          <th className="pb-2.5 font-medium text-right">TB / lượt</th>
                          <th className="pb-2.5 font-medium text-right">API Cost</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/40 text-xs">
                        {MODELS_DATA.map((mdl) => {
                          const sharePercent = (
                            (mdl.totalTokens / 86174507) *
                            100
                          ).toFixed(1);
                          const isSelected = selectedModel === mdl.id;
                          return (
                            <tr
                              key={mdl.id}
                              onClick={() =>
                                setSelectedModel(isSelected ? 'all' : mdl.id)
                              }
                              className={`cursor-pointer transition-colors ${
                                isSelected
                                  ? 'bg-indigo-500/10'
                                  : darkMode
                                  ? 'hover:bg-slate-800/40'
                                  : 'hover:bg-slate-50'
                              }`}
                            >
                              <td className="py-3.5 pr-2">
                                <div className="flex items-center gap-2">
                                  <span className={`w-2 h-2 rounded-full ${mdl.color}`} />
                                  <span className="font-mono font-bold">
                                    {mdl.name}
                                  </span>
                                  <span className="text-[10px] opacity-60 hidden sm:inline">
                                    ({mdl.speed})
                                  </span>
                                </div>
                                <div className="w-32 h-1 rounded-full bg-slate-800 mt-1.5 overflow-hidden">
                                  <div
                                    className={`h-full ${mdl.color}`}
                                    style={{ width: `${sharePercent}%` }}
                                  />
                                </div>
                              </td>
                              <td className="py-3.5 text-right font-mono">
                                {mdl.sessions}
                              </td>
                              <td className="py-3.5 text-right font-mono font-semibold">
                                {formatNumber(mdl.totalTokens)}
                              </td>
                              <td className="py-3.5 text-right font-mono opacity-75">
                                {formatNumber(mdl.avgPerCall)}
                              </td>
                              <td className="py-3.5 text-right font-mono text-amber-400 font-semibold">
                                {formatCost(mdl.cost)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Comparison Callout */}
                <div
                  className={`mt-4 p-3 rounded-xl border text-xs flex items-center justify-between ${
                    darkMode
                      ? 'bg-slate-900/60 border-slate-800/80 text-slate-300'
                      : 'bg-slate-50 border-slate-200 text-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>
                      <strong className="font-mono text-cyan-400">gpt-5.4-mini</strong> xử lý{' '}
                      <strong>49.3%</strong> tổng lượng token nhưng chỉ chiếm{' '}
                      <strong className="text-emerald-400">2.2%</strong> tổng chi phí.
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* ========================================== */}
            {/* USAGE THEO THỜI GIAN                       */}
            {/* ========================================== */}
            <div
              className={`p-5 rounded-2xl border ${
                darkMode
                  ? 'bg-[#11141D]/90 border-slate-800/80'
                  : 'bg-white border-slate-200/90 shadow-xs'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                <div>
                  <h3 className="text-base font-bold">Usage theo thời gian</h3>
                  <p className="text-xs opacity-60">
                    Thống kê chi tiết lưu lượng token theo mốc thời gian đã chọn
                  </p>
                </div>
                <div className="flex items-center gap-3 text-xs font-mono">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-emerald-400 inline-block" />
                    Cached (97.4%)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-indigo-400 inline-block" />
                    Uncached Input
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-violet-400 inline-block" />
                    Output
                  </span>
                </div>
              </div>

              {/* Visual Token Composition Bar */}
              <div className="w-full h-3 rounded-full bg-slate-800 overflow-hidden flex mb-5 p-0.5 gap-0.5">
                <div
                  className="h-full bg-emerald-400 rounded-l-full transition-all"
                  style={{ width: '96.8%' }}
                  title="Cached Token: 83.482.368"
                />
                <div
                  className="h-full bg-indigo-400 transition-all"
                  style={{ width: '2.6%' }}
                  title="New Input Token: 2.259.053"
                />
                <div
                  className="h-full bg-violet-400 rounded-r-full transition-all"
                  style={{ width: '0.6%' }}
                  title="Output Token: 433.086"
                />
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr
                      className={`border-b text-[11px] font-mono uppercase opacity-60 ${
                        darkMode ? 'border-slate-800' : 'border-slate-200'
                      }`}
                    >
                      <th className="pb-2.5 font-medium">Mốc ({granularity === 'day' ? 'Ngày' : 'Giờ'})</th>
                      <th className="pb-2.5 font-medium text-right">Calls</th>
                      <th className="pb-2.5 font-medium text-right">Input Token</th>
                      <th className="pb-2.5 font-medium text-right">Cached Token</th>
                      <th className="pb-2.5 font-medium text-right">Output Token</th>
                      <th className="pb-2.5 font-medium text-right">API Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/40 text-xs font-mono">
                    <tr className={darkMode ? 'hover:bg-slate-800/30' : 'hover:bg-slate-50'}>
                      <td className="py-3.5 font-semibold text-indigo-400">
                        2026-10-15 (Hôm nay)
                      </td>
                      <td className="py-3.5 text-right">15</td>
                      <td className="py-3.5 text-right">85.741.421</td>
                      <td className="py-3.5 text-right text-emerald-400 font-semibold">
                        83.482.368
                      </td>
                      <td className="py-3.5 text-right text-violet-400">433.086</td>
                      <td className="py-3.5 text-right text-amber-400 font-bold">
                        $8.865657
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* ========================================== */}
            {/* SESSIONS TRÊN MÁY (WITH INSPECT DRAWER)    */}
            {/* ========================================== */}
            <div
              className={`p-5 rounded-2xl border ${
                darkMode
                  ? 'bg-[#11141D]/90 border-slate-800/80'
                  : 'bg-white border-slate-200/90 shadow-xs'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
                <div>
                  <h3 className="text-base font-bold">Sessions trên máy</h3>
                  <p className="text-xs opacity-60">
                    Danh sách các phiên làm việc đã ghi nhận trên thiết bị local. Nhấn &ldquo;Chi tiết&rdquo; để xem từng lượt (turn)
                  </p>
                </div>

                {/* Search Input */}
                <div className="relative w-full sm:w-72">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 opacity-40" />
                  <input
                    type="text"
                    value={sessionSearch}
                    onChange={(e) => setSessionSearch(e.target.value)}
                    placeholder="Tìm theo project, model, session ID..."
                    className={`w-full pl-9 pr-3 py-2 rounded-xl border text-xs outline-none transition-colors ${
                      darkMode
                        ? 'bg-slate-900 border-slate-800 text-slate-200 focus:border-indigo-500'
                        : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-indigo-500'
                    }`}
                  />
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr
                      className={`border-b text-[11px] font-mono uppercase opacity-60 ${
                        darkMode ? 'border-slate-800' : 'border-slate-200'
                      }`}
                    >
                      <th className="pb-3 font-medium">Phiên / Project</th>
                      <th className="pb-3 font-medium">Nguồn</th>
                      <th className="pb-3 font-medium">Model</th>
                      <th className="pb-3 font-medium text-right">Lượt (Turns)</th>
                      <th className="pb-3 font-medium text-right">Tổng token</th>
                      <th className="pb-3 font-medium text-right">TB / lượt</th>
                      <th className="pb-3 font-medium text-right">Thời lượng</th>
                      <th className="pb-3 font-medium text-right">Chi phí</th>
                      <th className="pb-3 font-medium text-right">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/40 text-xs">
                    {filteredSessions.map((sess) => (
                      <tr
                        key={sess.id}
                        className={`transition-colors ${
                          darkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="py-4 pr-3">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-sm">
                              {sess.project}
                            </span>
                            {sess.status === 'spike_warning' && (
                              <span
                                title="Phiên có context spike"
                                className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-mono"
                              >
                                Spike
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] font-mono opacity-50 mt-0.5">
                            {sess.id} • {sess.lastActive}
                          </div>
                        </td>
                        <td className="py-4">
                          <span
                            className={`px-2 py-1 rounded-md text-[11px] font-mono ${
                              darkMode
                                ? 'bg-slate-800 text-slate-300'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {sess.source}
                          </span>
                        </td>
                        <td className="py-4">
                          <div className="flex items-center gap-1.5 font-mono">
                            <span
                              className={`w-2 h-2 rounded-full ${
                                sess.model === 'gpt-6-luna'
                                  ? 'bg-violet-400'
                                  : 'bg-cyan-400'
                              }`}
                            />
                            <span className="font-semibold">{sess.model}</span>
                            <span className="text-[10px] opacity-60">
                              ({sess.reasoning})
                            </span>
                          </div>
                        </td>
                        <td className="py-4 text-right font-mono font-semibold">
                          {sess.turns}
                        </td>
                        <td className="py-4 text-right font-mono font-bold">
                          {formatNumber(sess.totalTokens)}
                        </td>
                        <td className="py-4 text-right font-mono opacity-75">
                          {formatNumber(sess.avgTokens)}
                        </td>
                        <td className="py-4 text-right font-mono text-sky-400">
                          {sess.durationSec.toLocaleString('vi-VN')}s
                        </td>
                        <td className="py-4 text-right font-mono font-bold text-amber-400">
                          {formatCost(sess.cost)}
                        </td>
                        <td className="py-4 text-right">
                          <button
                            onClick={() => setInspectedSession(sess)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 font-medium transition-all active:scale-95"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>Chi tiết</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ===================================================================== */}
        {/* TAB 5: TEST CHAT (BẢN THIẾT KẾ LẠI TRANG THỨ HAI CỦA BẠN)             */}
        {/* ===================================================================== */}
        {activeTab === 'test-chat' && (
          <div className="max-w-5xl mx-auto">
            <div
              className={`rounded-2xl border overflow-hidden flex flex-col min-h-[680px] shadow-2xl ${
                darkMode
                  ? 'bg-[#11141D]/95 border-slate-800/90 shadow-black/40'
                  : 'bg-white border-slate-200/90 shadow-slate-200/60'
              }`}
            >
              {/* Top Bar of Test Chat */}
              <div
                className={`p-4 sm:px-6 border-b flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                  darkMode ? 'border-slate-800/80 bg-[#0D1017]' : 'border-slate-200 bg-slate-50/70'
                }`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold">Test chat</h2>
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-indigo-500/15 text-indigo-400 border border-indigo-500/25">
                      In-Memory Playground
                    </span>
                  </div>
                  <p className="text-xs opacity-60 mt-0.5">
                    Context chỉ giữ trong bộ nhớ trang. Reload sẽ xóa mọi tab và tin nhắn.
                  </p>
                </div>

                {/* Session Tabs Bar + "+ Tab mới" */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {chatTabs.map((t) => {
                    const isCurrent = t.id === activeChatTab.id;
                    return (
                      <div
                        key={t.id}
                        onClick={() => setActiveChatTabId(t.id)}
                        className={`group flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium cursor-pointer border transition-all ${
                          isCurrent
                            ? 'bg-indigo-600 text-white border-indigo-500 shadow-sm shadow-indigo-500/30'
                            : darkMode
                            ? 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                            : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        <MessageSquare className="w-3.5 h-3.5 opacity-80" />
                        <span>{t.title}</span>
                        {t.messages.length > 0 && (
                          <span
                            className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                              isCurrent ? 'bg-white/20 text-white' : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {t.messages.length}
                          </span>
                        )}
                      </div>
                    );
                  })}

                  <button
                    onClick={handleAddChatTab}
                    className={`flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all active:scale-95 ${
                      darkMode
                        ? 'bg-slate-900/90 border-slate-800 hover:border-indigo-500/50 text-slate-200'
                        : 'bg-white border-slate-200 hover:border-indigo-300 text-slate-700'
                    }`}
                  >
                    <Plus className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Tab mới</span>
                  </button>
                </div>
              </div>

              {/* Model & Reasoning Control Ribbon */}
              <div
                className={`px-4 sm:px-6 py-3 border-b flex flex-wrap items-center justify-between gap-3 ${
                  darkMode ? 'border-slate-800/60 bg-[#11141D]' : 'border-slate-200/70 bg-white'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2.5">
                  {/* Model Selector */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs opacity-60">Model</span>
                    <select
                      value={activeChatTab.model}
                      onChange={(e) => updateActiveChatTab({ model: e.target.value })}
                      className={`px-3 py-1.5 rounded-xl border text-xs font-mono font-semibold outline-none ${
                        darkMode
                          ? 'bg-slate-900 border-slate-800 text-violet-300 focus:border-indigo-500'
                          : 'bg-slate-50 border-slate-200 text-indigo-700 focus:border-indigo-500'
                      }`}
                    >
                      <option value="gpt-6-luna">gpt-6-luna</option>
                      <option value="gpt-5.4-mini">gpt-5.4-mini</option>
                      <option value="claude-4.5-sonnet">claude-4.5-sonnet</option>
                    </select>
                  </div>

                  {/* Copy Model Button */}
                  <button
                    onClick={handleCopyModel}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-all ${
                      darkMode
                        ? 'bg-slate-900 border-slate-800 hover:bg-slate-800 text-slate-300'
                        : 'bg-slate-50 border-slate-200 hover:bg-slate-100 text-slate-700'
                    }`}
                  >
                    {copiedModel ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5 opacity-70" />
                    )}
                    <span>Copy model</span>
                  </button>

                  {/* Reasoning Effort Selector */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs opacity-60">Reasoning</span>
                    <div
                      className={`flex items-center p-0.5 rounded-xl border ${
                        darkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-100 border-slate-200'
                      }`}
                    >
                      {['low', 'medium', 'high'].map((level) => (
                        <button
                          key={level}
                          onClick={() => updateActiveChatTab({ reasoning: level })}
                          className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-all ${
                            activeChatTab.reasoning === level
                              ? 'bg-indigo-600 text-white font-semibold shadow-xs'
                              : 'opacity-60 hover:opacity-100'
                          }`}
                        >
                          {level}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* System Context Toggle */}
                  <button
                    onClick={() =>
                      updateActiveChatTab({
                        showSystemPrompt: !activeChatTab.showSystemPrompt
                      })
                    }
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-colors ${
                      activeChatTab.showSystemPrompt
                        ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-300'
                        : darkMode
                        ? 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                        : 'bg-slate-50 border-slate-200 text-slate-600'
                    }`}
                  >
                    <Sliders className="w-3.5 h-3.5" />
                    <span>+ System context tùy chọn</span>
                  </button>
                </div>

                {/* Delete / Clear Tab Button */}
                <button
                  onClick={() => handleDeleteChatTab(activeChatTab.id)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-rose-500/25 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs font-medium transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Xóa tab</span>
                </button>
              </div>

              {/* Collapsible System Prompt Box */}
              {activeChatTab.showSystemPrompt && (
                <div
                  className={`px-6 py-3 border-b ${
                    darkMode ? 'bg-slate-950/70 border-slate-800' : 'bg-indigo-50/40 border-slate-200'
                  }`}
                >
                  <label className="block text-[11px] font-mono uppercase opacity-70 mb-1.5">
                    System Instructions (Gửi kèm đầu mỗi request trong tab này)
                  </label>
                  <textarea
                    rows={2}
                    value={activeChatTab.systemPrompt}
                    onChange={(e) =>
                      updateActiveChatTab({ systemPrompt: e.target.value })
                    }
                    placeholder="Nhập system prompt tùy chỉnh (VD: Bạn là chuyên gia tối ưu Rust/Go...)"
                    className={`w-full p-2.5 rounded-xl border text-xs font-mono outline-none ${
                      darkMode
                        ? 'bg-slate-900 border-slate-800 text-slate-200 focus:border-indigo-500'
                        : 'bg-white border-slate-200 text-slate-800 focus:border-indigo-500'
                    }`}
                  />
                </div>
              )}

              {/* Chat Messages Area / Empty State */}
              <div className="flex-1 p-6 overflow-y-auto space-y-5 max-h-[440px]">
                {activeChatTab.messages.length === 0 ? (
                  <div className="h-full py-12 flex flex-col items-center justify-center text-center max-w-lg mx-auto">
                    <div className="w-14 h-14 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 mb-4 shadow-inner">
                      <Sparkles className="w-7 h-7" />
                    </div>
                    <h3 className="text-lg font-bold">Bắt đầu một lượt test</h3>
                    <p
                      className={`text-xs mt-1.5 leading-relaxed ${
                        darkMode ? 'text-slate-400' : 'text-slate-500'
                      }`}
                    >
                      Chọn model, mức reasoning và gửi tin nhắn. Mỗi request gửi context hiện có trong tab này và đo đạc trực tiếp tốc độ sinh token (TTFT, tok/s) cùng tỷ lệ Prompt Cache.
                    </p>

                    {/* Quick Starter Prompts for Developer */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full mt-6">
                      {[
                        'Kiểm tra tốc độ phản hồi & trạng thái KV Cache hiện tại',
                        'Viết hàm parse log telemetry tối ưu bộ nhớ bằng TypeScript',
                        'Phân tích nguyên nhân gây Context Spike ở phiên mySeBrain',
                        'Test khả năng suy luận logic 3 bước với mức reasoning hiện tại'
                      ].map((sample, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleSendTestMessage(sample)}
                          className={`p-3 rounded-xl border text-left text-xs transition-all hover:-translate-y-0.5 flex items-start justify-between gap-2 ${
                            darkMode
                              ? 'bg-slate-900/70 border-slate-800 hover:border-indigo-500/50 text-slate-300'
                              : 'bg-slate-50 border-slate-200 hover:border-indigo-300 text-slate-700'
                          }`}
                        >
                          <span className="line-clamp-2">{sample}</span>
                          <ArrowUpRight className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  activeChatTab.messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${
                        msg.role === 'user' ? 'items-end' : 'items-start'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1 px-1 text-[11px] opacity-60 font-mono">
                        <span>{msg.role === 'user' ? 'Bạn' : msg.model}</span>
                        <span>•</span>
                        <span>{msg.timestamp}</span>
                      </div>

                      <div
                        className={`max-w-3xl rounded-2xl p-4 text-xs sm:text-sm leading-relaxed ${
                          msg.role === 'user'
                            ? 'bg-indigo-600 text-white rounded-br-xs shadow-md shadow-indigo-600/20'
                            : darkMode
                            ? 'bg-slate-900/95 border border-slate-800 text-slate-200 rounded-bl-xs'
                            : 'bg-slate-100 border border-slate-200 text-slate-800 rounded-bl-xs'
                        }`}
                      >
                        <div className="whitespace-pre-wrap">{msg.content}</div>

                        {/* Telemetry Footer inside Assistant Message */}
                        {msg.telemetry && (
                          <div
                            className={`mt-3 pt-2.5 border-t flex flex-wrap items-center gap-3 text-[11px] font-mono ${
                              darkMode
                                ? 'border-slate-800 text-slate-400'
                                : 'border-slate-200 text-slate-600'
                            }`}
                          >
                            <span className="text-emerald-400 font-semibold">
                              TTFT: {msg.telemetry.ttft}
                            </span>
                            <span>•</span>
                            <span>Speed: {msg.telemetry.speed}</span>
                            <span>•</span>
                            <span>
                              Reasoning: {msg.telemetry.reasoningTokens} tok
                            </span>
                            <span>•</span>
                            <span>
                              Cached: {msg.telemetry.cachedTokens} / {msg.telemetry.inputTokens}
                            </span>
                            <span>•</span>
                            <span className="text-amber-400 font-semibold">
                              {msg.telemetry.cost}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}

                {isStreaming && (
                  <div className="flex items-center gap-2 text-xs font-mono text-indigo-400 animate-pulse">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>
                      {activeChatTab.model} đang suy luận ({activeChatTab.reasoning})...
                    </span>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Composer Input Area */}
              <div
                className={`p-4 sm:px-6 border-t ${
                  darkMode ? 'bg-[#0D1017] border-slate-800/80' : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div
                  className={`rounded-2xl border p-2 transition-colors ${
                    darkMode
                      ? 'bg-slate-900/90 border-slate-800 focus-within:border-indigo-500/70'
                      : 'bg-white border-slate-200 focus-within:border-indigo-500'
                  }`}
                >
                  <textarea
                    rows={3}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendTestMessage();
                      }
                    }}
                    placeholder="Nhập tin nhắn... Enter để gửi, Shift + Enter để xuống dòng"
                    className="w-full px-2 py-1 text-xs sm:text-sm bg-transparent outline-none resize-none"
                  />

                  <div className="flex items-center justify-between pt-2 px-2 border-t border-slate-800/40">
                    <div className="flex items-center gap-3 text-[11px] font-mono opacity-60">
                      <span>Timeout mỗi request: 300s</span>
                      <span className="hidden sm:inline">•</span>
                      <span className="hidden sm:inline">
                        Ước tính: ~{Math.max(1, Math.ceil(chatInput.length / 4))} token
                      </span>
                    </div>

                    <button
                      onClick={() => handleSendTestMessage()}
                      disabled={!chatInput.trim() || isStreaming}
                      className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                        chatInput.trim() && !isStreaming
                          ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/30 active:scale-95'
                          : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                      }`}
                    >
                      <span>Gửi</span>
                      <Send className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ===================================================================== */}
        {/* TAB 1: THỐNG KÊ (OVERVIEW METRICS & REALTIME THROUGHPUT)              */}
        {/* ===================================================================== */}
        {activeTab === 'thong-ke' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className={`p-5 rounded-2xl border ${darkMode ? 'bg-[#11141D] border-slate-800' : 'bg-white border-slate-200'}`}>
                <span className="text-xs opacity-60">Uptime hệ thống</span>
                <div className="text-2xl font-bold font-mono mt-1 text-emerald-400">99.98%</div>
                <p className="text-xs opacity-60 mt-2">Khởi chạy liên tục 17 phút không lỗi</p>
              </div>
              <div className={`p-5 rounded-2xl border ${darkMode ? 'bg-[#11141D] border-slate-800' : 'bg-white border-slate-200'}`}>
                <span className="text-xs opacity-60">TTFT Trung bình</span>
                <div className="text-2xl font-bold font-mono mt-1 text-indigo-400">164 ms</div>
                <p className="text-xs opacity-60 mt-2">Nhanh hơn 42% nhờ Local Prefix Cache</p>
              </div>
              <div className={`p-5 rounded-2xl border ${darkMode ? 'bg-[#11141D] border-slate-800' : 'bg-white border-slate-200'}`}>
                <span className="text-xs opacity-60">Tốc độ sinh Token</span>
                <div className="text-2xl font-bold font-mono mt-1 text-violet-400">178 tok/s</div>
                <p className="text-xs opacity-60 mt-2">Đỉnh 245 tok/s trên gpt-5.4-mini</p>
              </div>
              <div className={`p-5 rounded-2xl border ${darkMode ? 'bg-[#11141D] border-slate-800' : 'bg-white border-slate-200'}`}>
                <span className="text-xs opacity-60">Tiết kiệm nhờ Cache hôm nay</span>
                <div className="text-2xl font-bold font-mono mt-1 text-amber-400">$94.20</div>
                <p className="text-xs opacity-60 mt-2">Chỉ trả $8.86 thay vì $103.06</p>
              </div>
            </div>

            <div className={`p-6 rounded-2xl border ${darkMode ? 'bg-[#11141D] border-slate-800' : 'bg-white border-slate-200'}`}>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-base font-bold">Biểu đồ lưu lượng Token theo khung giờ (Hôm nay)</h3>
                  <p className="text-xs opacity-60">So sánh lượng Cached Token và Uncached Input theo từng giờ</p>
                </div>
                <button
                  onClick={() => setActiveTab('codex-usage')}
                  className="text-xs text-indigo-400 hover:underline font-medium"
                >
                  Xem bảng chi tiết Codex Usage →
                </button>
              </div>

              {/* Custom Bar Chart */}
              <div className="grid grid-cols-8 gap-3 items-end h-48 pt-6 px-2 border-b border-slate-800">
                {[
                  { hour: '07:00', val: 25, tok: '4,2 Tr' },
                  { hour: '08:00', val: 45, tok: '8,9 Tr' },
                  { hour: '09:00', val: 75, tok: '16,4 Tr' },
                  { hour: '10:00', val: 60, tok: '12,1 Tr' },
                  { hour: '11:00', val: 85, tok: '19,8 Tr' },
                  { hour: '12:00', val: 35, tok: '6,5 Tr' },
                  { hour: '13:00', val: 95, tok: '18,2 Tr' },
                  { hour: 'Hiện tại', val: 40, tok: 'Live' }
                ].map((bar, i) => (
                  <div key={i} className="flex flex-col items-center gap-2 h-full justify-end group">
                    <span className="text-[10px] font-mono opacity-0 group-hover:opacity-100 transition-opacity text-emerald-400">
                      {bar.tok}
                    </span>
                    <div
                      className="w-full max-w-[44px] rounded-t-lg bg-gradient-to-t from-indigo-600 to-emerald-400 transition-all group-hover:brightness-110"
                      style={{ height: `${bar.val}%` }}
                    />
                    <span className="text-[11px] font-mono opacity-60 pb-2">{bar.hour}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ===================================================================== */}
        {/* TAB 2: REQUEST TRỰC TIẾP (LIVE STREAMING LOGS)                        */}
        {/* ===================================================================== */}
        {activeTab === 'request-truc-tiep' && (
          <div className={`p-5 rounded-2xl border ${darkMode ? 'bg-[#11141D] border-slate-800' : 'bg-white border-slate-200'}`}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                <h3 className="text-base font-bold">Luồng Request trực tiếp (Live Stream)</h3>
              </div>
              <span className="text-xs font-mono opacity-60">Tự động cập nhật qua WebSocket</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs font-mono">
                <thead>
                  <tr className={`border-b uppercase opacity-60 ${darkMode ? 'border-slate-800' : 'border-slate-200'}`}>
                    <th className="pb-3">Req ID</th>
                    <th className="pb-3">Thời gian</th>
                    <th className="pb-3">Project</th>
                    <th className="pb-3">Model</th>
                    <th className="pb-3 text-right">Input / Cached</th>
                    <th className="pb-3 text-right">Output</th>
                    <th className="pb-3 text-right">TTFT / Tổng</th>
                    <th className="pb-3 text-right">Chi phí</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {LIVE_REQUESTS.map((r) => (
                    <tr key={r.id} className={darkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'}>
                      <td className="py-3.5 text-indigo-400 font-semibold">{r.id}</td>
                      <td className="py-3.5 opacity-70">{r.time}</td>
                      <td className="py-3.5">{r.project}</td>
                      <td className="py-3.5 text-violet-400">{r.model}</td>
                      <td className="py-3.5 text-right">
                        {formatNumber(r.input)}{' '}
                        <span className="text-emerald-400">({formatNumber(r.cached)})</span>
                      </td>
                      <td className="py-3.5 text-right">{formatNumber(r.output)}</td>
                      <td className="py-3.5 text-right">
                        <span className="text-emerald-400">{r.ttft}</span> / {r.duration}
                      </td>
                      <td className="py-3.5 text-right text-amber-400 font-bold">{r.cost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ===================================================================== */}
        {/* TAB 4: VIDEO BUILDS                                                   */}
        {/* ===================================================================== */}
        {activeTab === 'video-builds' && (
          <div className={`p-5 rounded-2xl border ${darkMode ? 'bg-[#11141D] border-slate-800' : 'bg-white border-slate-200'}`}>
            <div className="mb-4">
              <h3 className="text-base font-bold">Video Builds & Render Pipeline</h3>
              <p className="text-xs opacity-60">Theo dõi tiến trình xuất video tự động từ các agent</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {VIDEO_BUILDS.map((vb) => (
                <div
                  key={vb.id}
                  className={`p-4 rounded-xl border ${
                    darkMode ? 'bg-slate-900/70 border-slate-800' : 'bg-slate-50 border-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-mono mb-2">
                    <span className="text-indigo-400">{vb.id}</span>
                    <span
                      className={`px-2 py-0.5 rounded ${
                        vb.status === 'Completed'
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-amber-500/15 text-amber-400 animate-pulse'
                      }`}
                    >
                      {vb.status}
                    </span>
                  </div>
                  <div className="font-bold text-sm">{vb.title}</div>
                  <div className="text-xs opacity-60 mt-1">
                    Project: <span className="font-mono">{vb.project}</span>
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-800/60 flex justify-between text-xs font-mono">
                    <span>{vb.resolution}</span>
                    <span>Render: {vb.renderTime}</span>
                    <span className="text-amber-400">{vb.cost}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ===================================================================== */}
        {/* TAB 6: MODEL & GIÁ                                                    */}
        {/* ===================================================================== */}
        {activeTab === 'model-gia' && (
          <div className={`p-5 rounded-2xl border ${darkMode ? 'bg-[#11141D] border-slate-800' : 'bg-white border-slate-200'}`}>
            <div className="mb-4">
              <h3 className="text-base font-bold">Cấu hình Model & Bảng giá quy đổi API</h3>
              <p className="text-xs opacity-60">
                Đơn giá dùng để tính toán chi phí tương đương (API equivalent) trên toàn bộ Codex Server
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className={`border-b font-mono uppercase opacity-60 ${darkMode ? 'border-slate-800' : 'border-slate-200'}`}>
                    <th className="pb-3">Tên Model</th>
                    <th className="pb-3">Provider</th>
                    <th className="pb-3 text-right">Context tối đa</th>
                    <th className="pb-3 text-right">Giá Input</th>
                    <th className="pb-3 text-right">Giá Cached Input</th>
                    <th className="pb-3 text-right">Giá Output</th>
                    <th className="pb-3 text-right">Trạng thái</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50 font-mono">
                  {MODEL_PRICING.map((mp) => (
                    <tr key={mp.model}>
                      <td className="py-4 font-bold text-violet-400">{mp.model}</td>
                      <td className="py-4 opacity-80">{mp.provider}</td>
                      <td className="py-4 text-right">{mp.contextWindow} tok</td>
                      <td className="py-4 text-right">{mp.inputPrice}</td>
                      <td className="py-4 text-right text-emerald-400 font-semibold">{mp.cachedPrice}</td>
                      <td className="py-4 text-right">{mp.outputPrice}</td>
                      <td className="py-4 text-right">
                        <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                          {mp.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>

      {/* ========================================== */}
      {/* FOOTER TELEMETRY BAR                       */}
      {/* ========================================== */}
      <footer
        className={`mt-12 border-t py-4 text-xs font-mono ${
          darkMode
            ? 'border-slate-800/80 bg-[#090B10]/90 text-slate-500'
            : 'border-slate-200 bg-white text-slate-500'
        }`}
      >
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div>
            Đồng bộ lúc 13:36:25 15/10/2026 · Làm mới mỗi {countdown} giây
          </div>
          <div className="flex items-center gap-4">
            <span>Uptime: 17m 21s</span>
            <span>•</span>
            <span>Có 15 request trong cửa sổ lọc</span>
          </div>
        </div>
      </footer>

      {/* ========================================== */}
      {/* SLIDE-OVER DRAWER: CHI TIẾT SESSION        */}
      {/* ========================================== */}
      {inspectedSession && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs animate-fadeIn">
          <div
            className={`w-full max-w-2xl h-full overflow-y-auto p-6 border-l shadow-2xl flex flex-col justify-between ${
              darkMode
                ? 'bg-[#0E1118] border-slate-800 text-slate-100'
                : 'bg-white border-slate-200 text-slate-900'
            }`}
          >
            <div>
              {/* Drawer Header */}
              <div className="flex items-start justify-between pb-4 border-b border-slate-800">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                      {inspectedSession.id}
                    </span>
                    <span className="text-xs font-mono opacity-60">
                      • {inspectedSession.source}
                    </span>
                  </div>
                  <h3 className="text-lg font-bold mt-1">
                    Chi tiết phiên: {inspectedSession.project}
                  </h3>
                </div>
                <button
                  onClick={() => setInspectedSession(null)}
                  className="p-2 rounded-xl hover:bg-slate-800/60 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Summary Mini Grid */}
              <div className="grid grid-cols-3 gap-3 my-5">
                <div
                  className={`p-3.5 rounded-xl border ${
                    darkMode ? 'bg-slate-900/80 border-slate-800' : 'bg-slate-50 border-slate-200'
                  }`}
                >
                  <div className="text-[11px] opacity-60">Tổng lượng Token</div>
                  <div className="text-base font-bold font-mono mt-1">
                    {formatNumber(inspectedSession.totalTokens)}
                  </div>
                </div>
                <div
                  className={`p-3.5 rounded-xl border ${
                    darkMode ? 'bg-slate-900/80 border-slate-800' : 'bg-slate-50 border-slate-200'
                  }`}
                >
                  <div className="text-[11px] opacity-60">Tỷ lệ Cache Hit</div>
                  <div className="text-base font-bold font-mono mt-1 text-emerald-400">
                    {inspectedSession.cachedRatio}%
                  </div>
                </div>
                <div
                  className={`p-3.5 rounded-xl border ${
                    darkMode ? 'bg-slate-900/80 border-slate-800' : 'bg-slate-50 border-slate-200'
                  }`}
                >
                  <div className="text-[11px] opacity-60">Tổng chi phí API</div>
                  <div className="text-base font-bold font-mono mt-1 text-amber-400">
                    {formatCost(inspectedSession.cost)}
                  </div>
                </div>
              </div>

              {/* Turn-by-turn Breakdown Table */}
              <h4 className="text-xs font-mono uppercase tracking-wider opacity-70 mb-3">
                Diễn biến từng lượt gọi (Turn-by-Turn Telemetry)
              </h4>
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-left border-collapse text-xs font-mono">
                  <thead>
                    <tr className="bg-slate-900/90 text-slate-400 border-b border-slate-800">
                      <th className="p-3">Turn</th>
                      <th className="p-3 text-right">Input</th>
                      <th className="p-3 text-right">Cached</th>
                      <th className="p-3 text-right">Output</th>
                      <th className="p-3 text-right">Latency</th>
                      <th className="p-3 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {inspectedSession.turnBreakdown.map((t) => (
                      <tr key={t.turn} className="hover:bg-slate-800/30">
                        <td className="p-3 font-bold text-indigo-400">#{t.turn}</td>
                        <td className="p-3 text-right">{formatNumber(t.input)}</td>
                        <td className="p-3 text-right text-emerald-400">
                          {formatNumber(t.cached)}
                        </td>
                        <td className="p-3 text-right">{formatNumber(t.output)}</td>
                        <td className="p-3 text-right">{t.latency}</td>
                        <td className="p-3 text-right text-amber-400">
                          ${t.cost.toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-800 flex justify-end gap-2">
              <button
                onClick={() => {
                  setInspectedSession(null);
                  setActiveTab('test-chat');
                }}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
              >
                Mở cấu hình này trong Test Chat
              </button>
              <button
                onClick={() => setInspectedSession(null)}
                className="px-4 py-2 rounded-xl border border-slate-700 text-xs font-medium"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}