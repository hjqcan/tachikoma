---
name: frontend-design
description:
  Create distinctive, production-grade frontend interfaces with high design quality. Use this skill
  when the user asks to build web components, pages, artifacts, posters, or applications (examples
  include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when
  styling/beautifying any web UI). Generates creative, polished code and UI design that avoids
  generic AI aesthetics.
license: Complete terms in LICENSE.txt
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic
"AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details
and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They
may include context about the purpose, audience, or technical constraints.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:

- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural,
  luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric,
  soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for
  inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and
refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:

- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:

- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like
  Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics;
  unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant
  colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for
  HTML. Use Motion library for React when available. Focus on high-impact moments: one
  well-orchestrated page load with staggered reveals (animation-delay) creates more delight than
  scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking
  elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid
  colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms
  like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic
  shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system
fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable
layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No
design should be the same. Vary between light and dark themes, different fonts, different
aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need
elaborate code with extensive animations and effects. Minimalist or refined designs need restraint,
precision, and careful attention to spacing, typography, and subtle details. Elegance comes from
executing the vision well.

Remember: Claude is capable of extraordinary creative work. Don't hold back, show what can truly be
created when thinking outside the box and committing fully to a distinctive vision.

## Reference-Based Design (仿站场景 - CRITICAL)

When the user mentions a **specific product name** (e.g., "网易云音乐", "Spotify", "淘宝",
"Netflix"), this is a **Reference Task**, NOT a creative design task.

**Mandatory Actions**:

1. **Identify the product's visual signature**
   - Primary color (e.g., 网易云 = #C20C0C red, Spotify = #1DB954 green)
   - Layout structure (sidebar navigation, header bar, content grid)
   - Key UI components (playlist cards, player bar, comment section)

2. **Implement following the reference**
   - Use the product's color scheme as your CSS variables
   - Replicate the layout structure faithfully
   - Match the component styling closely

3. **Absolutely FORBIDDEN**:
   - ❌ Using Vite/CRA default template content (logos, counters, "Edit App.tsx")
   - ❌ Using generic purple/blue gradients instead of the product's colors
   - ❌ Inventing a new design when the user asked for a specific product style
   - ❌ Keeping default scaffold styling like the "React + Vite + Tailwind" header

**Example**: User: "创建一个网易云音乐网站"

```css
:root {
  --primary-color: #c20c0c; /* NetEase Cloud Music Red */
  --bg-dark: #2c2c2c;
  --text-light: #fff;
}
```

```tsx
// NOT this:
<h1>React + Vite + Tailwind</h1>

// YES this:
<aside className="sidebar bg-[#C20C0C]">
  <nav>发现音乐 | 我的音乐 | 朋友 | 账号</nav>
</aside>
```
