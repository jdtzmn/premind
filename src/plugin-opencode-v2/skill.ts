import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type Plugin, Skill } from "@opencode/plugin"

const skillPath = fileURLToPath(new URL("./skills/premind/SKILL.md", import.meta.url))

/** Splits the generated SKILL.md into its frontmatter description and body. */
export function readPremindSkill(path = skillPath) {
	const source = readFileSync(path, "utf8")
	const match = /^---\n([\s\S]*?)\n---\n+/.exec(source)
	if (!match) throw new Error(`Premind skill has no frontmatter: ${path}`)
	const description = /^description: (.+)$/m.exec(match[1])?.[1]
	if (!description) throw new Error(`Premind skill has no description: ${path}`)
	return { path, description, content: source.slice(match[0].length) }
}

export function registerSkill(ctx: Plugin.Context) {
	const skill = readPremindSkill()
	return ctx.skill.transform((editor) => {
		editor.add({
			id: Skill.ID.make("premind"),
			name: Skill.Name.make("premind"),
			description: skill.description,
			path: Skill.Info.fields.path.make(skill.path),
			content: skill.content,
		})
	})
}
