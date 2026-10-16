import { ChevronDown, Server, Wifi, WifiOff } from "lucide-react";
import { DerivedNodeStatus } from "../../status/useStatusPolling";
import { formatTimestamp, formatRelativeAge } from "../../../format";

interface Props { nodes: DerivedNodeStatus[]; selectedNodeId: string | null; onSelectNodeId: (nodeId: string | null) => void }

export function NodesSection({ nodes, selectedNodeId, onSelectNodeId }: Props) {
  const onlineCount = nodes.filter(node => node.connected).length;
  return <section className="nodes-section leader-machine-scope" aria-label="看板机器范围">
    <div className="machine-scope-controls">
      <label className="machine-filter"><Server size={16} aria-hidden="true" /><span>机器</span>
        <select className="filter-select" aria-label="筛选看板机器" value={selectedNodeId || ""} onChange={event => onSelectNodeId(event.target.value || null)}>
          <option value="">全部机器 · {nodes.length}</option>
          {selectedNodeId && !nodes.some(node => node.nodeId === selectedNodeId) && <option value={selectedNodeId}>{selectedNodeId} · 未报告</option>}
          {nodes.map(node => <option key={node.nodeId} value={node.nodeId}>{node.nodeId}{node.connected ? "" : " · 离线"}</option>)}
        </select>
      </label>
      {selectedNodeId && <button type="button" className="text-button" onClick={() => onSelectNodeId(null)}>清除机器筛选</button>}
    </div>
    <details className="machine-details"><summary><span>机器状态</span><span>{onlineCount} / {nodes.length} 在线</span><ChevronDown size={15} aria-hidden="true" /></summary>
    {!nodes.length ? <div role="status" className="empty-panel"><Server size={24} aria-hidden="true" /><h3>暂无已连接的宿主节点</h3><p>机器连接后，会话与在线状态会出现在这里。</p></div> : <div className="node-list">{nodes.map((node) => {
      const selected = selectedNodeId === node.nodeId;
      const Icon = node.connected ? Wifi : WifiOff;
      return <button type="button" key={node.nodeId} data-testid={`node-card-${node.nodeId}`} className={`node-card ${selected ? "selected" : ""}`} aria-pressed={selected} aria-label={selected ? `取消筛选节点 ${node.nodeId}` : `按节点 ${node.nodeId} 筛选会话与指令`} onClick={() => onSelectNodeId(selected ? null : node.nodeId)}>
        <div className="node-title"><Server size={18} aria-hidden="true" /><strong>{node.nodeId}</strong><Icon size={16} aria-hidden="true" /></div>
        <div className="node-info"><span className={node.connected ? "online" : "offline"}>{node.connected ? "在线 (ONLINE)" : "离线 (OFFLINE)"}</span><span>{node.sessionCount} 个会话</span></div>
        <p title={formatTimestamp(node.lastHeartbeat)}>{node.inferredOffline ? "历史会话 · 连接未报告" : `心跳 ${formatRelativeAge(node.lastHeartbeat)}`}</p>
      </button>;
    })}</div>}
    </details>
  </section>;
}
