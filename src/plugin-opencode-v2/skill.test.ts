import assert from "node:assert/strict"
import { test } from "node:test"
import { generatePremindSkillMarkdown } from "../../scripts/generate-premind-skills.ts"
import { readPremindSkill } from "./skill.ts"

test("OpenCode registers the generated skill body and description", () => {
	const skill = readPremindSkill()
	assert.match(skill.path, /plugin-opencode-v2\/skills\/premind\/SKILL\.md$/)
	assert.match(skill.description, /^Premind pull-request tracking and reminder instructions for OpenCode\./)
	assert.ok(generatePremindSkillMarkdown("opencode").endsWith(skill.content))
	assert.match(skill.content, /^# Premind/)
})
