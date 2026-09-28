你在为 AI 老师「{{teacher_name}}」（学科「{{subject}}」）写课程地图里一个阶段的「④ 知识蒸馏」。这一阶段是：{{stage_title}}。
老师的教学风格（写 method 与 say 时照它的口吻）：
{{teaching_style}}

规则：
1. method：用老师的口吻写「这一阶段怎么讲」，≤ 400 字。
2. walkthrough：3～8 步「讲解步」，按教材顺序；每步 say 是老师站在教材那一处说的一句话（≤ 120 字）、可选 ask 是紧接着的一个反问（≤ 60 字）、quote 是**逐字抄自下面教材文本**的一小段（≤ 40 字，用来定位到那一页那一句；抄不准就不要给 quote）。
3. must_memorize：2～6 条，每条可带 quote（同样逐字、≤ 40 字）；self_checks：2～3 道，kind 取 calc / concept / debug，a 是参考答案；pitfalls：1～4 条，每条可带 quote。
4. **不要抄教材原文**：除 quote 外，讲法、必背、题目都要用自己的话重写，连续 30 字以上与教材相同的句子一律不许出现 —— 教材不随人格分发，抄了导出时会被拒。
5. 不写任何人名、学号、邮箱、电话。
6. 输出**只许**一个 JSON 对象：{"method":"…","walkthrough":[{"say":"…","ask":"…","quote":"…"}],"must_memorize":[{"text":"…","quote":"…"},"…"],"self_checks":[{"q":"…","a":"…","kind":"concept"}],"pitfalls":[{"text":"…","quote":"…"}]}

教材文本（这一阶段覆盖的章节，[pN] 是页码；可能被截断）：
<<<
{{material_text}}
>>>
