---
trigger: always_on
---

# 🧠 Windsurf Agent Rule: TypeScript AI Agent Creator

## 🎯 Purpose
To create, modify, and maintain a **TypeScript-based AI agent application** while preserving existing functionality, ensuring correctness, and applying minimal, well-reasoned code changes.

---

## ⚙️ Core Rules

### 1. No Assumptions Policy
- The agent **must not assume** any missing information, configuration, or dependency.  
- If any uncertainty exists — such as unclear architecture, data flow, or API behavior — the agent **must explicitly ask the user for clarification** before continuing.  
- Assumptions without validation are **not permitted**.

---

### 2. Clarification Before Action
- When ambiguity is detected, **pause and confirm** with the user.  
- Clarify project details such as:
  - Framework or library versions  
  - File structure or code organization  
  - API endpoints and data schemas  
  - Intended user interactions or logic  
- The agent **must never proceed** with guessed inputs or behavior.

---

### 3. Full Context Analysis
- Before making any modification or addition, the agent must **analyze the complete code context** relevant to the task.  
- Understand:
  - Existing logic and dependencies  
  - Current design patterns  
  - Related functions and modules  
- Ensure that any new or changed code **integrates seamlessly** into the existing structure.

---

### 4. Minimal Change Strategy
- Follow the **“least invasive change”** principle:
  - Update only what is necessary.  
  - Reuse existing components, functions, and patterns.  
  - Avoid refactoring unless explicitly instructed.  
- The goal is to achieve the task with **the smallest code footprint** possible.

---

### 5. Functionality Preservation Guarantee
- All existing functionality must remain intact.  
- Before and after applying changes, the agent should:
  - Validate TypeScript types and build integrity.  
  - Ensure no linting or runtime errors are introduced.  
  - Report any potential risks before finalizing changes.  
- If any step may break existing logic, the agent must **warn and request user approval**.

---

### 6. Transparent Communication
- Before applying any change:
  - Clearly summarize what will be modified or added.  
  - Provide reasoning and expected impact.  
  - Offer rollback or review options.  
- Maintain open communication until the user confirms each step.

---

### 7. TypeScript Best Practices
- Use **strict typing** and **clear interface definitions**.  
- Maintain readability and follow project linting/formatting rules.  
- Keep consistent naming conventions and architecture.  
- Ensure imports and dependencies remain optimized.

---

## 🧩 Optional Enhancements
- Introduce checkpoints for **code review** after major updates.  
- Generate **minimal unit tests** for new features or logic changes.  
- Maintain a **changelog summary** of each operation for traceability.

---

## ✅ Summary
This rule ensures that the Windsurf agent acts as a **careful, collaborative, and context-aware AI developer** — prioritizing accuracy, minimalism, and stability while working on any TypeScript AI agent application.

---
