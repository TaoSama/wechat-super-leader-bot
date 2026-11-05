import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import { ResourceEditor, type EditableResource } from "../../src/features/settings/ResourceEditor";

const resource: EditableResource = { id: "prompt", title: "微信助手系统提示", kind: "prompt", scope: "微信助手 · 下一轮", content: "original", revision: "v1", editable: true };
it("首次被动 effect 前输入的草稿不会被初始化覆盖", () => {
  const dirty = vi.fn();
  const save = vi.fn();
  function EditDuringCommit() {
    useLayoutEffect(() => {
      const editor = screen.getByLabelText("文件内容");
      // Dispatch during commit to exercise input before passive effects deterministically.
      editor.dispatchEvent(createEvent.change(editor, { target: { value: "early draft" } }));
    }, []);
    return <ResourceEditor resource={resource} onSave={save} onDirtyChange={dirty} />;
  }
  render(<EditDuringCommit />);
  expect(screen.getByLabelText("文件内容")).toHaveValue("early draft");
  expect(dirty).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
});
it("切换资源身份会初始化新草稿并使用新修订保存", async () => {
  const dirty = vi.fn();
  const save = vi.fn(async (current: EditableResource, content: string) => ({ ...current, content, revision: "v3" }));
  const { rerender } = render(<ResourceEditor resource={resource} onSave={save} onDirtyChange={dirty} />);
  fireEvent.change(screen.getByLabelText("文件内容"), { target: { value: "first draft" } });
  const next = { ...resource, id: "memory", content: "second resource", revision: "v2" };
  rerender(<ResourceEditor resource={next} onSave={save} onDirtyChange={dirty} />);
  expect(screen.getByLabelText("文件内容")).toHaveValue("second resource");
  expect(screen.getByText("v2")).toBeInTheDocument();
  expect(dirty).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByLabelText("文件内容"), { target: { value: "second draft" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("已保存");
  expect(save).toHaveBeenCalledExactlyOnceWith(next, "second draft");
}, 15000);
it("并发冲突时保留草稿，不显示假保存成功", async () => {
  const save = vi.fn(async () => { throw new Error("内容已更新，请重新读取后合并"); });
  render(<ResourceEditor resource={resource} onSave={save} />);
  fireEvent.change(screen.getByLabelText("文件内容"), { target: { value: "new draft" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("文件内容")).toHaveValue("new draft");
  expect(save).toHaveBeenCalledWith(resource, "new draft");
  expect(screen.queryByText("已保存")).toBeNull();
}, 15000);
it("保存使用回执修订并允许撤销下一次修改", async () => {
  const save = vi.fn(async () => ({ ...resource, content: "new", revision: "v2" }));
  render(<ResourceEditor resource={resource} onSave={save} />);
  fireEvent.change(screen.getByLabelText("文件内容"), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("已保存");
  expect(screen.getByText("v2")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("文件内容"), { target: { value: "changed" } });
  fireEvent.click(screen.getByRole("button", { name: "撤销修改" }));
  await waitFor(() => expect(screen.getByLabelText("文件内容")).toHaveValue("new"));
}, 15000);
it.each([
  { editable: false, reason: "Schema 由对应原生实现定义；此处可查看实际启用配置" },
  { editable: true, reason: "Gateway 每轮注入的指令主体；Codex 内建系统提示词不由此修改" },
  { editable: true, reason: "Schema 保留原身份和结构；执行器保留原参数及权限校验" },
])("资源说明可见且编辑权限准确：$reason", ({ editable, reason }) => {
  render(<ResourceEditor resource={{ ...resource, editable, reason }} onSave={vi.fn()} />);
  expect(screen.getByText(reason)).toBeInTheDocument();
  const editor = screen.getByLabelText("文件内容");
  if (editable) {
    expect(editor).not.toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
  } else {
    expect(editor).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  }
}, 15000);

it("同一资源的新快照不会覆盖正在编辑的草稿", () => {
  const { rerender } = render(<ResourceEditor resource={resource} onSave={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("文件内容"), { target: { value: "working draft" } });
  rerender(<ResourceEditor resource={{ ...resource, content: "external update", revision: "v3" }} onSave={vi.fn()} />);
  expect(screen.getByLabelText("文件内容")).toHaveValue("working draft");
  expect(screen.getByText("v1")).toBeInTheDocument();
}, 15000);
it("冲突后读取最新内容保留草稿与对照，再由用户显式保存", async () => {
  const latest = { ...resource, content: "server latest", revision: "v3" };
  const save = vi.fn().mockRejectedValueOnce(new Error("版本冲突，草稿已保留")).mockImplementation(async (current, content) => ({ ...current, content, revision: "v4" }));
  render(<ResourceEditor resource={resource} onSave={save} onReload={async () => latest} />);
  fireEvent.change(screen.getByLabelText("文件内容"), { target: { value: "my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  fireEvent.click(await screen.findByRole("button", { name: "读取最新内容" }));
  await screen.findByText("server latest");
  expect(screen.getByLabelText("文件内容")).toHaveValue("my draft");
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("已保存");
  expect(save).toHaveBeenLastCalledWith(latest, "my draft");
}, 15000);
it("过期覆盖值显示新默认内容，保存后不再提示", async () => {
  const stale = { ...resource, content: "旧版覆盖", stale: true, defaultContent: "新版默认正文" };
  const save = vi.fn(async (current: EditableResource, content: string) => ({ ...current, content, revision: "v2", stale: false, defaultContent: undefined }));
  render(<ResourceEditor resource={stale} onSave={save} />);
  expect(screen.getByText(/默认内容已更新/)).toBeInTheDocument();
  expect(screen.getByText("新版默认正文")).toBeInTheDocument();
  expect(screen.getByLabelText("文件内容")).toHaveValue("旧版覆盖");
  fireEvent.change(screen.getByLabelText("文件内容"), { target: { value: "合并后的内容" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByText(/默认内容已更新/)).not.toBeInTheDocument());
});
