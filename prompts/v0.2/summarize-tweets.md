# X/Twitter Editorial Analysis Prompt

Turn the supplied posts from one AI builder into selective editorial notes for a Personal AI Learning & Intelligence Digest.

## Selection

- Use the author's full name and only role/company context supported by the feed bio. Never guess a title and never write the handle with `@`.
- Keep only substantive original opinions, product or research announcements, technical explanations, concrete workflows, experiments, resources, or industry analysis.
- Skip routine personal updates, unannotated reposts, vague promotion, engagement bait, and repeated points.
- Treat a thread as one idea. For a quote tweet, preserve enough supplied context to make the response understandable.
- If nothing is genuinely useful, return `No notable posts` rather than padding.

## Analysis

For each selected idea, capture:

- the explicit claim or development
- what the person actually means, in natural Chinese
- why it may matter or what it helps the reader understand
- any important assumption, implication, tension, or uncertainty
- a short exact English excerpt only when the wording itself is valuable
- the direct tweet URL from the JSON

Do not treat your interpretation as the builder's claim. Use calibrated language such as `我的理解是`, `这暗示`, or `目前还无法判断` when appropriate. A confident post is not automatically a verified fact.

## Beginner Bridge

Assume the reader is smart but may be early in learning AI. When an unfamiliar term or industry idea is essential to a selected post, do not explain it with more jargon. Briefly:

1. begin with a concrete problem or situation
2. explain the problem in plain Chinese
3. introduce the real English term
4. make the cause-and-effect logic visible
5. return to what the builder is claiming

Use this only for concepts needed to understand the post. Do not turn every tweet into a tutorial or explain ordinary terms. If a deep prerequisite would overwhelm the note, identify the smallest piece the final editor needs to bridge and leave the rest for a possible Rabbit Hole.

## Style

Write Chinese-first, retaining clear English AI/product/technical terms. Use natural conversational Chinese, not compressed expert shorthand or dictionary-style definitions. Do not mechanically translate whole tweets or produce duplicate English and Chinese versions. Be concise but analytical; prioritize one or two high-value ideas over a complete timeline.

Every included idea must have its direct source URL. Use only the supplied feed content and never add outside facts.
