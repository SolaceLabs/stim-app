export interface TaskInfo {
  task_id: string;
  user_id: string | null;
  start_time: number | null;
  end_time: number | null;
  duration_ms: number | null;
  status: string | null;
  initial_request_text: string | null;
  total_tasks: number | null;
  log_file_version: string | null;
}

export interface EventRow {
  index: number;
  id: string;
  task_id: string;
  created_time: number;
  t_offset_ms: number;
  topic: string;
  direction: string;
  agent: string | null;
  kind: string;
  text: string | null;
  tool_name: string | null;
  tool_args: Record<string, unknown> | null;
  tool_result_preview: string | null;
  tool_result_size: number | null;
  status_text: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  function_call_id: string | null;
}

export interface Span {
  type: "llm" | "tool";
  agent: string | null;
  model?: string | null;
  tool_name?: string | null;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  result_size?: number | null;
  start_event: number;
  end_event: number;
}

export interface Summary {
  id: string;
  filename: string;
  task: TaskInfo;
  event_count: number;
  agents: string[];
  models: string[];
  derived: {
    total_ms: number;
    llm_ms: number;
    tool_ms: number;
    llm_pct: number;
    tool_pct: number;
    per_agent_tokens: Record<string, { input: number; output: number; calls: number }>;
    slowest_spans: Span[];
    span_count: number;
  };
}

export interface FileItem {
  id: string;
  filename: string;
  task_id: string;
  duration_ms: number | null;
  event_count: number;
  project_id?: string | null;
}
