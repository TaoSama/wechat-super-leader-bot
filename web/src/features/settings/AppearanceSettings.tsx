import { Monitor, Moon, Sun } from "lucide-react";
export type ThemePreference = "light" | "dark" | "system";
interface Props { value: ThemePreference; onChange: (value: ThemePreference) => void }
const choices = [{ value: "light", label: "浅色", icon: Sun }, { value: "dark", label: "深色", icon: Moon }, { value: "system", label: "跟随系统", icon: Monitor }] as const;
export function AppearanceSettings({ value, onChange }: Props) {
  return <section className="settings-section"><h3>外观</h3><p className="settings-description">保存在当前浏览器，打开工作台时自动使用。</p><div className="settings-theme-choices" role="group" aria-label="外观模式">{choices.map(({ value: choice, label, icon: Icon }) => <button type="button" key={choice} aria-pressed={choice === value} onClick={() => onChange(choice)}><Icon size={19} aria-hidden="true" /><span>{label}</span></button>)}</div></section>;
}
