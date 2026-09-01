/** Locale bundles for the Prime-orchestration settings section. */

/** Locale keys the section renders. */
export type PrimeOrchestrationKey =
  | 'nav' | 'sectionIntro' | 'restartNote'
  | 'enable' | 'enableHint'
  | 'hostConfig' | 'bin' | 'binHint' | 'stateDir' | 'stateDirHint'
  | 'daemonSocket' | 'daemonSocketHint' | 'maxDelegations' | 'maxDelegationsHint'
  | 'delegationDefaults'
  | 'delegateModel' | 'delegateProvider' | 'delegateThinking'
  | 'delegateGoalTokenBudget' | 'delegateAutonomous' | 'delegateAutonomousMaxContinuations'
  | 'heartbeatDefaults' | 'heartbeatIntervalMs' | 'heartbeatIntervalMsHint'
  | 'heartbeatTimeoutMs' | 'heartbeatTimeoutMsHint'
  | 'save' | 'saving' | 'saved' | 'reset'
  | 'readOnly' | 'loading' | 'unavailable' | 'error' | 'optional'

/** English copy. */
export const en: Record<PrimeOrchestrationKey, string> = {
  nav: 'Prime orchestration',
  sectionIntro:
    'Defaults for the prime_agent tool\'s delegations, its host-plane overrides, and heartbeat checks. '
    + 'A delegate request that names a field overrides its default.',
  restartNote: 'Changes take effect after the deployment restarts.',
  enable: 'Enable prime orchestration',
  enableHint:
    'When off, the preset registers no tool, routes, prompt, or skill, and the fleet column disappears.',
  hostConfig: 'Host configuration',
  bin: 'prime-agent binary',
  binHint: 'Empty inherits the row config or PRIME_AGENT_BIN.',
  stateDir: 'State directory',
  stateDirHint: 'Empty inherits the row config (default ~/.dsh/prime-orchestrator).',
  daemonSocket: 'Daemon socket',
  daemonSocketHint: 'Empty inherits the row config or PRIME_AGENT_DAEMON_SOCKET.',
  maxDelegations: 'Max concurrent delegations',
  maxDelegationsHint: 'Ceiling on how many prime-agent delegations may run at once.',
  delegationDefaults: 'Delegation defaults',
  delegateModel: 'Model',
  delegateProvider: 'Provider',
  delegateThinking: 'Thinking',
  delegateGoalTokenBudget: 'Goal token budget',
  delegateAutonomous: 'Autonomous',
  delegateAutonomousMaxContinuations: 'Autonomous max continuations',
  heartbeatDefaults: 'Heartbeat defaults',
  heartbeatIntervalMs: 'Check interval (ms)',
  heartbeatIntervalMsHint: 'How often the orchestrator checks a session\'s heartbeat; 0 means off.',
  heartbeatTimeoutMs: 'Check timeout (ms)',
  heartbeatTimeoutMsHint: 'How long one heartbeat check may take; 0 means off.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  reset: 'Discard changes',
  readOnly: 'This browser cannot write settings; the values shown are read-only.',
  loading: 'Loading…',
  unavailable: 'Prime orchestration is not exposed to this browser.',
  error: 'Could not save settings.',
  optional: 'optional',
}

/** Simplified Chinese copy. */
export const zh: Record<PrimeOrchestrationKey, string> = {
  nav: 'Prime 编排',
  sectionIntro: 'prime_agent 工具的委派默认值、主机侧覆盖项与心跳检查。委派请求中显式给出的字段会覆盖默认值。',
  restartNote: '修改将在部署重启后生效。',
  enable: '启用 Prime 编排',
  enableHint: '关闭后，该预设不再注册工具、路由、提示词与技能，舰队列也会消失。',
  hostConfig: '主机配置',
  bin: 'prime-agent 可执行文件',
  binHint: '留空则继承行配置或 PRIME_AGENT_BIN。',
  stateDir: '状态目录',
  stateDirHint: '留空则继承行配置（默认 ~/.dsh/prime-orchestrator）。',
  daemonSocket: '守护进程套接字',
  daemonSocketHint: '留空则继承行配置或 PRIME_AGENT_DAEMON_SOCKET。',
  maxDelegations: '最大并发委派数',
  maxDelegationsHint: '同时运行的 prime-agent 委派数量上限。',
  delegationDefaults: '委派默认值',
  delegateModel: '模型',
  delegateProvider: '提供商',
  delegateThinking: '思考',
  delegateGoalTokenBudget: '目标 Token 预算',
  delegateAutonomous: '自主模式',
  delegateAutonomousMaxContinuations: '自主最大续跑次数',
  heartbeatDefaults: '心跳默认值',
  heartbeatIntervalMs: '检查间隔（毫秒）',
  heartbeatIntervalMsHint: '编排器检查会话心跳的频率；0 表示关闭。',
  heartbeatTimeoutMs: '检查超时（毫秒）',
  heartbeatTimeoutMsHint: '单次心跳检查的时限；0 表示关闭。',
  save: '保存',
  saving: '正在保存…',
  saved: '已保存',
  reset: '放弃更改',
  readOnly: '此浏览器无法写入设置，以下值仅可读。',
  loading: '正在加载…',
  unavailable: '此浏览器未暴露 Prime 编排。',
  error: '无法保存设置。',
  optional: '可选',
}