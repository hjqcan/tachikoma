# Chapter 10: Model Context Protocol | <mark>第 10 章：模型上下文协议</mark>

To enable LLMs to function effectively as agents, their capabilities must extend beyond multimodal generation. Interaction with the external environment is necessary, including access to current data, utilization of external software, and execution of specific operational tasks. The Model Context Protocol (MCP) addresses this need by providing a standardized interface for LLMs to interface with external resources. This protocol serves as a key mechanism to facilitate consistent and predictable integration.

<mark>要让大语言模型（LLM）成为高效的智能体，仅具备多模态生成能力是不够的。智能体还需要与外部环境交互，比如获取实时数据、调用外部软件、执行具体操作。模型上下文协议（Model Context Protocol，MCP）正是为此而生，它为 LLM 与外部资源的交互提供了标准化接口，是实现一致、可预测集成的关键机制。</mark>

------

## MCP Pattern Overview | <mark>MCP 模式概览</mark>

Imagine a universal adapter that allows any LLM to plug into any external system, database, or tool without a custom integration for each one. That's essentially what the Model Context Protocol (MCP) is. It's an open standard designed to standardize how LLMs like Gemini, OpenAI's GPT models, Mixtral, and Claude communicate with external applications, data sources, and tools. Think of it as a universal connection mechanism that simplifies how LLMs obtain context, execute actions, and interact with various systems.

<mark>想象一个通用适配器，能让任何大语言模型（LLM）轻松接入各种外部系统、数据库或工具，而无需为每个系统单独开发定制方案，这正是 MCP 的核心价值。MCP 是一个开放标准，统一规范了 Gemini、OpenAI GPT、Mixtral 和 Claude 等主流大语言模型与外部应用、数据源、工具之间的通信方式。可以将它理解为通用连接机制，极大简化了大语言模型获取上下文、执行操作、与系统交互的过程。</mark>

MCP operates on a client-server architecture. It defines how different elements—data (referred to as resources), interactive templates (which are essentially prompts), and actionable functions (known as tools)—are exposed by an MCP server. These are then consumed by an MCP client, which could be an LLM host application or an AI agent itself. This standardized approach dramatically reduces the complexity of integrating LLMs into diverse operational environments.

<mark>MCP 基于「客户端 - 服务器」架构运行。协议明确定义了 MCP 服务器如何对外提供三类核心元素：数据（称为资源）、交互模板（本质上是提示词）、可执行功能（称为工具）。MCP 客户端会使用这些元素，这里的客户端可以是 LLM 应用，也可以是 AI 智能体本身。这种标准化架构极大简化了将 LLM 集成到不同操作环境的复杂度。</mark>

However, MCP is a contract for an "agentic interface," and its effectiveness depends heavily on the design of the underlying APIs it exposes. There is a risk that developers simply wrap pre-existing, legacy APIs without modification, which can be suboptimal for an agent. For example, if a ticketing system's API only allows retrieving full ticket details one by one, an agent asked to summarize high-priority tickets will be slow and inaccurate at high volumes. To be truly effective, the underlying API should be improved with deterministic features like filtering and sorting to help the non-deterministic agent work efficiently. This highlights that agents do not magically replace deterministic workflows; they often require stronger deterministic support to succeed.

<mark>不过需要认识到，MCP 本质上是一个「智能体接口」的协议规范，其实际效果很大程度上取决于底层 API 的设计质量。这里存在一个潜在风险：开发者可能只是简单地将现有的老旧 API 套上 MCP 外壳，而没有针对智能体的特殊需求进行优化。举个例子，假如某个票务系统的 API 只支持逐个查询工单详情，那么当智能体需要汇总大量高优先级工单时，就会因为频繁调用而变得缓慢且不准确。</mark>

<mark>要让智能体真正发挥效能，底层 API 需要针对性改进，增加过滤、排序等确定性功能，帮助非确定性的 AI 智能体更高效工作。这说明了一个重要原则：AI 智能体无法神奇地取代传统的确定性工作流程，反而往往需要更强大的确定性支持才能成功。</mark>

Furthermore, MCP can wrap an API whose input or output is still not inherently understandable by the agent. An API is only useful if its data format is agent-friendly, a guarantee that MCP itself does not enforce. For instance, creating an MCP server for a document store that returns files as PDFs is mostly useless if the consuming agent cannot parse PDF content. The better approach would be to first create an API that returns a textual version of the document, such as Markdown, which the agent can actually read and process. This demonstrates that developers must consider not just the connection, but the nature of the data being exchanged to ensure true compatibility.

<mark>还需要注意，MCP 虽然能够封装各种 API，但这些 API 的输入输出格式未必是智能体能够理解的。一个 API 要真正有用，其数据格式必须对智能体友好，而这一点 MCP 协议本身无法强制保证。</mark>

<mark>举个例子：若为文档存储系统创建的 MCP 服务器只返回 PDF 文件，而智能体无法解析 PDF 内容，那么这样的设计没有什么实际意义。更好的做法是先构建能返回文本版本（如 Markdown 格式）的 API，让智能体能真正读取和处理内容。这揭示了一个重要原则：设计 MCP 集成时，不能只关注连接机制，更要深入考虑数据交换的本质，才能确保真正的兼容性和实用性。</mark>

------

## MCP vs. Tool Function Calling | <mark>MCP 与工具函数调用</mark>

The Model Context Protocol (MCP) and tool function calling are distinct mechanisms that enable LLMs to interact with external capabilities (including tools) and execute actions. While both serve to extend LLM capabilities beyond text generation, they differ in their approach and level of abstraction.

<mark>模型上下文协议（MCP）与工具函数调用是两种不同的技术机制，它们都能够让大语言模型与外部能力（包括各类工具）进行交互并执行具体操作。尽管这两种技术都致力于增强 LLM 的能力，使其不再局限于单纯的文本生成，但它们在实现方法和抽象层级上存在显著差异。</mark>

Tool function calling can be thought of as a direct request from an LLM to a specific, pre-defined tool or function. Note that in this context we use the words "tool" and "function" interchangeably. This interaction is characterized by a one-to-one communication model, where the LLM formats a request based on its understanding of a user's intent requiring external action. The application code then executes this request and returns the result to the LLM. This process is often proprietary and varies across different LLM providers.

<mark>工具函数调用本质上是大语言模型向特定预定义工具或功能发出的直接调用请求。需要说明的是，在技术语境下，「工具」和「函数」这两个术语通常可互换使用，指的是同一类可执行的外部能力。</mark>

<mark>这种交互模式的核心特征是一对一通信架构：LLM 首先基于对用户意图的理解（特别是需要外部能力才能完成的请求），按既定格式构造调用请求；随后，应用程序代码接收并执行请求，最终将结果返回给 LLM 处理。当前工具函数调用的具体实现往往是各 LLM 平台厂商的专有方案，不同提供商之间的实现方式和接口规范存在明显差异和不兼容性。</mark>

In contrast, the Model Context Protocol (MCP) operates as a standardized interface for LLMs to discover, communicate with, and utilize external capabilities. It functions as an open protocol that facilitates interaction with a wide range of tools and systems, aiming to establish an ecosystem where any compliant tool can be accessed by any compliant LLM. This fosters interoperability, composability and reusability across different systems and implementations. By adopting a federated model, we significantly improve interoperability and unlock the value of existing assets. This strategy allows us to bring disparate and legacy services into a modern ecosystem simply by wrapping them in an MCP-compliant interface. These services continue to operate independently, but can now be composed into new applications and workflows, with their collaboration orchestrated by LLMs. This fosters agility and reusability without requiring costly rewrites of foundational systems.

<mark>相比之下，MCP 是用于大语言模型发现、通信和利用外部能力的标准化接口。作为开放协议，它促进了 LLM 与广泛工具、系统的交互，旨在建立一个开放生态，让任何兼容工具都可被任何兼容 LLM 访问。这使得不同系统可以相互连接、灵活组合、反复利用。</mark>

<mark>通过采用这种去中心化的协作模式，MCP 显著提高了系统互通性，让既有服务焕发新价值。这一策略的优势在于：只需为老旧或异构服务包装一层 MCP 兼容接口，就能将它们接入现代 AI 生态。这些服务继续独立运行，但现在可以组合成新的应用和工作流，由 LLM 统一调度。这种方式无需昂贵的系统重写，就能提升整体灵活性和可重用性。</mark>

Here's a breakdown of the fundamental distinctions between MCP and tool function calling:

<mark>以下是 MCP 与工具函数调用之间基本区别的详细分析：</mark>

| Feature         | Tool Function Calling                                        | Model Context Protocol (MCP)                                 |
| :-------------- | :----------------------------------------------------------- | :----------------------------------------------------------- |
| Standardization | Proprietary and vendor-specific. The format and implementation differ across LLM providers. | An open, standardized protocol, promoting interoperability between different LLMs and tools. |
| Scope           | A direct mechanism for an LLM to request the execution of a specific, predefined function. | A broader framework for how LLMs and external tools discover and communicate with each other. |
| Architecture    | A one-to-one interaction between the LLM and the application's tool-handling logic. | A client-server architecture where LLM-powered applications (clients) can connect to and utilize various MCP servers (tools). |
| Discovery       | The LLM is explicitly told which tools are available within the context of a specific conversation. | Enables dynamic discovery of available tools. An MCP client can query a server to see what capabilities it offers. |
| Reusability     | Tool integrations are often tightly coupled with the specific application and LLM being used. | Promotes the development of reusable, standalone "MCP servers" that can be accessed by any compliant application. |

| <mark>特性</mark>       | <mark>工具函数调用</mark>                                    | <mark>模型上下文协议（MCP）</mark>                           |
| :---------------------- | :----------------------------------------------------------- | :----------------------------------------------------------- |
| <mark>标准化程度</mark> | <mark>厂商专有实现，不同 LLM 提供商采用各自的格式和实现方案。</mark> | <mark>开放的标准化协议，推动不同 LLM 与工具间的互操作能力。</mark> |
| <mark>功能范围</mark>   | <mark>LLM 直接调用执行特定预定义功能的机制。</mark>           | <mark>构建 LLM 与外部工具发现和通信的完整框架体系。</mark>     |
| <mark>系统架构</mark>   | <mark>LLM 与应用工具处理逻辑间的点对点直接交互。</mark>       | <mark>基于「客户端 - 服务器」架构，支持 LLM 应用连接多种 MCP 服务器。</mark> |
| <mark>发现机制</mark>   | <mark>在会话上下文中静态配置可用工具列表。</mark>            | <mark>支持工具能力的动态发现和查询机制。</mark>              |
| <mark>可复用性</mark>   | <mark>工具集成与特定应用和 LLM 平台深度绑定。</mark>           | <mark>推动可独立部署的 MCP 服务器开发，支持跨平台复用。</mark> |

Think of tool function calling as giving an AI a specific set of custom-built tools, like a particular wrench and screwdriver. This is efficient for a workshop with a fixed set of tasks. MCP (Model Context Protocol), on the other hand, is like creating a universal, standardized power outlet system. It doesn't provide the tools itself, but it allows any compliant tool from any manufacturer to plug in and work, enabling a dynamic and ever-expanding workshop.

<mark>可以将工具函数调用类比为一套为 AI 专门定制的工具，比如特定的扳手和螺丝刀。这种方案对执行固定任务集合的工作环境十分高效。相比之下，MCP 则类似于建立一套通用化、标准化的电源接口系统。MCP 本身不直接提供具体工具，而是构建开放的基础设施，允许任何厂商生产的兼容设备都能接入并正常工作，从而打造一个能够动态扩展、持续演进的工具生态系统。</mark>

In short, function calling provides direct access to a few specific functions, while MCP is the standardized communication framework that lets LLMs discover and use a vast range of external resources. For simple applications, specific tools are enough; for complex, interconnected AI systems that need to adapt, a universal standard like MCP is essential.

<mark>简而言之，函数调用提供对有限特定功能的直接访问，而 MCP 则构建了标准化通信框架，使 LLM 能够发现并利用广泛的外部资源生态系统。</mark>

<mark>对于功能需求简单的应用，专用工具集已足够；但对于需要高度适应性、涉及多系统复杂交互的 AI 应用，采用 MCP 这样的通用标准协议是构建可持续演进架构的关键。</mark>

------

## Additional considerations for MCP | <mark>MCP 的其他考虑因素</mark>

While MCP presents a powerful framework, a thorough evaluation requires considering several crucial aspects that influence its suitability for a given use case. Let's see some aspects in more details:

<mark>虽然 MCP 框架提供了强大的功能，但要在特定场景中充分评估其适用性，我们还需要考虑几个关键因素。让我们来详细了解一下这些方面：</mark>

- **Tool vs. Resource vs. Prompt:** It's important to understand the specific roles of these components. A resource is static data (e.g., a PDF file, a database record). A tool is an executable function that performs an action (e.g., sending an email, querying an API). A prompt is a template that guides the LLM in how to interact with a resource or tool, ensuring the interaction is structured and effective.

   <mark><strong>工具 vs. 资源 vs. 提示词：</strong>理解这些组件各自的角色很关键。资源指的是静态数据（比如 PDF 文件或数据库记录），工具则是可以执行操作的功能（比如发送邮件或调用 API），而提示词就像是指导 LLM 如何与资源或工具进行交互的模板，确保整个交互过程既规范又高效。</mark>

- **Discoverability:** A key advantage of MCP is that an MCP client can dynamically query a server to learn what tools and resources it offers. This "just-in-time" discovery mechanism is powerful for agents that need to adapt to new capabilities without being redeployed.

   <mark><strong>可发现性：</strong>MCP 的一大优势是，客户端能够实时查询服务器，动态获取可用的工具和资源列表。这种「即时发现」的机制特别适合需要灵活适应新功能而无需重新部署的智能体。</mark>

- **Security:** Exposing tools and data via any protocol requires robust security measures. An MCP implementation must include authentication and authorization to control which clients can access which servers and what specific actions they are permitted to perform.

   <mark><strong>安全性：</strong>无论通过什么协议开放工具和数据，都需要完善的安全保障。MCP 的实现必须包含身份验证和权限控制，确保只有授权客户端才能访问指定服务器，并限定其可执行的操作范围。</mark>

- **Implementation:** While MCP is an open standard, its implementation can be complex. However, providers are beginning to simplify this process. For example, some model providers like Anthropic or FastMCP offer SDKs that abstract away much of the boilerplate code, making it easier for developers to create and connect MCP clients and servers.

   <mark><strong>实现：</strong>尽管 MCP 是开放标准，但实际落地可能较为复杂。好在一些厂商正在简化这个过程，比如 Anthropic 和 FastMCP 等模型提供商推出的 SDK，帮助开发者处理了大量模板代码，让创建和连接 MCP 客户端与服务器变得更轻松。</mark>

- **Error Handling:** A comprehensive error-handling strategy is critical. The protocol must define how errors (e.g., tool execution failure, unavailable server, invalid request) are communicated back to the LLM so it can understand the failure and potentially try an alternative approach.

   <mark><strong>错误处理：</strong>一套完善的错误处理机制非常重要。协议需要明确规定如何将各种错误情况（比如工具执行失败、服务器无法连接或者请求格式有误）清晰地反馈给 LLM，这样它才能理解问题所在，并尝试其他的解决方案。</mark>

- **Local vs. Remote Server:** MCP servers can be deployed locally on the same machine as the agent or remotely on a different server. A local server might be chosen for speed and security with sensitive data, while a remote server architecture allows for shared, scalable access to common tools across an organization.

   <mark><strong>本地 vs. 远程服务器：</strong>MCP 服务器既可以部署在智能体所在的本地机器上，也可以放在远程服务器中。本地部署通常用于追求更快响应速度和更好保护敏感数据；远程架构则更适合需要在组织内共享工具资源、支持灵活扩展的场景。</mark>

- **On-demand vs. Batch:** MCP can support both on-demand, interactive sessions and larger-scale batch processing. The choice depends on the application, from a real-time conversational agent needing immediate tool access to a data analysis pipeline that processes records in batches.

   <mark><strong>按需 vs. 批处理：</strong>MCP 既支持实时交互的按需调用，也能应对大规模的批量处理。具体选择哪种方式要看实际应用需求，可能是需要即时反馈的对话型智能体，也可能是对数据记录进行批处理的分析流程。</mark>

- **Transportation Mechanism:** The protocol also defines the underlying transport layers for communication. For local interactions, it uses JSON-RPC over STDIO (standard input/output) for efficient inter-process communication. For remote connections, it leverages web-friendly protocols like Streamable HTTP and Server-Sent Events (SSE) to enable persistent and efficient client-server communication.

   <mark><strong>传输机制：</strong>协议还定义了底层的通信传输层。对于本地交互，可以使用基于 JSON-RPC 的标准输入/输出来实现高效的进程间通信。对于远程连接，则采用 Streamable HTTP 和服务器发送事件（SSE）等 Web 友好协议，以实现持久、高效的「客户端 - 服务器」通信。</mark>

The Model Context Protocol uses a client-server model to standardize information flow. Understanding component interaction is key to MCP's advanced agentic behavior:

<mark>MCP 采用「客户端 - 服务器」模型来标准化信息流。理解各组件如何交互，是掌握 MCP 高级智能体行为的关键：</mark>

1. **Large Language Model (LLM):** The core intelligence. It processes user requests, formulates plans, and decides when it needs to access external information or perform an action.

   <mark><strong>大语言模型（LLM）：</strong>作为整个系统的智能核心，它负责处理用户请求、制定执行计划，并判断何时需要调用外部资源或执行具体操作。</mark>

2. **MCP Client:** This is an application or wrapper around the LLM. It acts as the intermediary, translating the LLM's intent into a formal request that conforms to the MCP standard. It is responsible for discovering, connecting to, and communicating with MCP Servers.

   <mark><strong>MCP 客户端：</strong>这是一个包装了 LLM 的应用程序，扮演中间人角色，将 LLM 的意图转化为符合 MCP 标准的请求。它的主要职责是发现可用的 MCP 服务器、建立连接并维护通信。</mark>

3. **MCP Server:** This is the gateway to the external world. It exposes a set of tools, resources, and prompts to any authorized MCP Client. Each server is typically responsible for a specific domain, such as a connection to a company's internal database, an email service, or a public API.

   <mark><strong>MCP 服务器：</strong>相当于通往外部世界的桥梁，向经过授权的 MCP 客户端开放一系列工具、资源和提示模板。每个服务器通常专注于某个特定领域，比如对接企业内部的数据库系统、邮件服务平台或者公共 API 接口。</mark>

4. **Optional Third-Party (3P) Service:** This represents the actual external tool, application, or data source that the MCP Server manages and exposes. It is the ultimate endpoint that performs the requested action, such as querying a proprietary database, interacting with a SaaS platform, or calling a public weather API.

   <mark><strong>可选的第三方服务：</strong>这些是 MCP 服务器实际管理和对接的外部工具、应用或数据源，也是最终执行具体操作的终端。无论是查询专有数据库、与 SaaS 平台进行交互，还是调用天气 API 获取实时数据，都是通过这些第三方服务来完成的。</mark>

The interaction flows as follows:

<mark>核心交互流程如下：</mark>

1. **Discovery:** The MCP Client, on behalf of the LLM, queries an MCP Server to ask what capabilities it offers. The server responds with a manifest listing its available tools (e.g., send_email), resources (e.g., customer_database), and prompts.

   <mark><strong>发现阶段：</strong>MCP 客户端会代表 LLM 去查询 MCP 服务器，了解它具体提供哪些能力。服务器会返回一份清单，详细列出可用的工具（例如 <code>send_email</code>）、资源（例如 <code>customer_database</code>）和提示词。</mark>

2. **Request Formulation:** The LLM determines that it needs to use one of the discovered tools. For instance, it decides to send an email. It formulates a request, specifying the tool to use (send_email) and the necessary parameters (recipient, subject, body).

   <mark><strong>请求构建：</strong> LLM 根据需求决定要使用哪个工具，比如说想要发送邮件。它会构建一个具体的请求，明确指定要调用的工具（<code>send_email</code>）以及必要的参数信息（收件人、邮件主题、正文内容等）。</mark>

3. **Client Communication:** The MCP Client takes the LLM's formulated request and sends it as a standardized call to the appropriate MCP Server.

   <mark><strong>客户端通信：</strong>MCP 客户端拿到 LLM 构建好的请求后，会按照标准格式将这个调用请求发送给对应的 MCP 服务器。</mark>

4. **Server Execution:** The MCP Server receives the request. It authenticates the client, validates the request, and then executes the specified action by interfacing with the underlying software (e.g., calling the send() function of an email API).

   <mark><strong>服务器执行：</strong>MCP 服务器收到请求后，会先进行客户端身份验证和请求合法性检查，确认无误后才会通过底层软件接口（比如调用邮件 API 的 <code>send()</code> 函数）来执行具体的操作。</mark>

5. **Response and Context Update:** After execution, the MCP Server sends a standardized response back to the MCP Client. This response indicates whether the action was successful and includes any relevant output (e.g., a confirmation ID for the sent email). The client then passes this result back to the LLM, updating its context and enabling it to proceed with the next step of its task.

   <mark><strong>响应和上下文更新：</strong>操作执行完成后，MCP 服务器会按照标准格式将响应结果返回给 MCP 客户端。这个响应会告诉客户端操作是否成功，并附带相关的输出信息（比如发送邮件后得到的确认编号）。客户端随后将这些结果反馈给 LLM，帮助它更新当前的任务上下文，为下一步操作做好准备。</mark>

------

## Practical Applications & Use Cases | <mark>实际应用场景</mark>

MCP significantly broadens AI/LLM capabilities, making them more versatile and powerful. Here are nine key use cases:

<mark>MCP 极大地拓展了 AI 和大语言模型的应用范围，使其更加灵活强大。以下是九个典型应用场景：</mark>

- **Database Integration:** MCP allows LLMs and agents to seamlessly access and interact with structured data in databases. For instance, using the MCP Toolbox for Databases, an agent can query Google BigQuery datasets to retrieve real-time information, generate reports, or update records, all driven by natural language commands.

   <mark><strong>数据库集成：</strong>通过 MCP，LLM 和智能体能够轻松对接数据库中的结构化数据并进行交互。比如借助 MCP 数据库工具箱，智能体可以直接用自然语言指令来查询 Google BigQuery 数据集，实时获取信息、生成报表或者更新记录。</mark>

- **Generative Media Orchestration:** MCP enables agents to integrate with advanced generative media services. Through MCP Tools for Genmedia Services, an agent can orchestrate workflows involving Google's Imagen for image generation, Google's Veo for video creation, Google's Chirp 3 HD for realistic voices, or Google's Lyria for music composition, allowing for dynamic content creation within AI applications.

   <mark><strong>生成式媒体编排：</strong>MCP 让智能体能够整合各类先进的生成式媒体服务。通过 MCP 媒体生成工具，智能体可以调用 Google Imagen 生成图片、使用 Google Veo 制作视频、通过 Google Chirp 3 HD 合成语音、或利用 Google Lyria 创作音乐，为 AI 应用提供动态内容创作能力。</mark>

- **External API Interaction:** MCP provides a standardized way for LLMs to call and receive responses from any external API. This means an agent can fetch live weather data, pull stock prices, send emails, or interact with CRM systems, extending its capabilities far beyond its core language model.

   <mark><strong>外部 API 交互：</strong>MCP 为 LLM 提供了标准化的外部 API 调用方式。智能体可以获取实时天气、查询股价、发送邮件，还能与 CRM 系统等业务平台对接，大幅拓展语言模型的应用范围。</mark>

- **Reasoning-Based Information Extraction:** Leveraging an LLM's strong reasoning skills, MCP facilitates effective, query-dependent information extraction that surpasses conventional search and retrieval systems. Instead of a traditional search tool returning an entire document, an agent can analyze the text and extract the precise clause, figure, or statement that directly answers a user's complex question.

   <mark><strong>基于推理的信息提取：</strong>借助 LLM 强大的推理能力，MCP 实现了比传统搜索更高效的信息提取。传统搜索只能返回整篇文档，而智能体能深入分析文本，精准提取出直接回答用户问题的具体条款、数据或关键陈述。</mark>

- **Custom Tool Development:** Developers can build custom tools and expose them via an MCP server (e.g., using FastMCP). This allows specialized internal functions or proprietary systems to be made available to LLMs and other agents in a standardized, easily consumable format, without needing to modify the LLM directly.

   <mark><strong>自定义工具开发：</strong> 开发者可以基于实际需求构建专属工具，并通过 MCP 服务器（比如使用 FastMCP）对外开放。这样就能把企业内部的专业功能或私有系统以标准化、易用的方式提供给 LLM 和各种智能体，无需对 LLM 本身进行任何修改。</mark>

- **Standardized LLM-to-Application Communication:** MCP ensures a consistent communication layer between LLMs and the applications they interact with. This reduces integration overhead, promotes interoperability between different LLM providers and host applications, and simplifies the development of complex agentic systems.

   <mark><strong>标准化通信桥梁：</strong>MCP 在 LLM 和应用程序之间建立了一个统一的通信层，不仅降低了系统集成的复杂度，还促进了不同 LLM 提供商和应用平台之间的互操作性，让开发复杂的智能体系统变得更加简单高效。</mark>

- **Complex Workflow Orchestration:** By combining various MCP-exposed tools and data sources, agents can orchestrate highly complex, multi-step workflows. An agent could, for example, retrieve customer data from a database, generate a personalized marketing image, draft a tailored email, and then send it, all by interacting with different MCP services.

   <mark><strong>复杂工作流编排：</strong>通过整合多个 MCP 开放的工具和数据源，智能体能够协调执行高度复杂的多步骤工作流程。例如，它可以从数据库提取客户信息，自动生成个性化的营销图片，撰写定制化的邮件内容，最后完成发送，整个过程都是通过调用不同的 MCP 服务来实现。</mark>

- **IoT Device Control:** MCP can facilitate LLM interaction with Internet of Things (IoT) devices. An agent could use MCP to send commands to smart home appliances, industrial sensors, or robotics, enabling natural language control and automation of physical systems.

   <mark><strong>物联网设备控制：</strong> MCP 还可以帮助 LLM 与物联网设备进行交互。智能体能够通过 MCP 向智能家居设备、工业传感器或机器人发送控制指令，实现对物理系统的自然语言控制和自动化管理。</mark>

- **Financial Services Automation:** In financial services, MCP could enable LLMs to interact with various financial data sources, trading platforms, or compliance systems. An agent might analyze market data, execute trades, generate personalized financial advice, or automate regulatory reporting, all while maintaining secure and standardized communication.

   <mark><strong>金融服务自动化：</strong>在金融领域，MCP 让 LLM 能够对接各种金融数据源、交易平台和合规系统。智能体可以分析市场行情、执行交易指令、提供个性化的理财建议，或者自动完成监管报表，同时确保所有通信都符合安全标准和规范要求。</mark>

In short, the Model Context Protocol (MCP) enables agents to access real-time information from databases, APIs, and web resources. It also allows agents to perform actions like sending emails, updating records, controlling devices, and executing complex tasks by integrating and processing data from various sources. Additionally, MCP supports media generation tools for AI applications.

<mark>简而言之，MCP 让智能体能够实时获取来自数据库、API 和网络资源的信息，还能够通过整合处理多方数据来执行发送邮件、更新记录、控制设备、完成复杂任务等操作。此外，MCP 还支持各类媒体生成工具，为 AI 应用提供更丰富的能力。</mark>

------

## Hands-On Code Example with ADK | <mark>实战示例：使用 Google ADK</mark>

This section outlines how to connect to a local MCP server that provides file system operations, enabling an ADK agent to interact with the local file system.

<mark>本节内容将演示智能体如何连接到提供文件系统操作的本地 MCP 服务器，使其能够与本地文件系统进行交互。</mark>

### Agent Setup with MCPToolset | <mark>智能体设置：使用 MCPToolset</mark>

To configure an agent for file system interaction, an `agent.py` file must be created (e.g., at `./adk_agent_samples/mcp_agent/agent.py`). The `MCPToolset` is instantiated within the `tools` list of the `LlmAgent` object. It is crucial to replace `"/path/to/your/folder"` in the `args` list with the absolute path to a directory on the local system that the MCP server can access. This directory will be the root for the file system operations performed by the agent.

<mark>想要让智能体具备文件系统交互能力，需要先创建一个 <code>agent.py</code> 文件（例如放在 <code>./adk_agent_samples/mcp_agent/agent.py</code> 目录下）。<code>MCPToolset</code> 在 <code>LlmAgent</code> 对象的 <code>tools</code> 列表中实例化。这里有个特别需要注意的地方：记得把 <code>args</code> 列表里的 <code>"/path/to/your/folder"</code> 替换成你本地系统上一个真实存在的目录绝对路径，而且要确保 MCP 服务器有权限访问这个目录。这个目录会作为智能体进行文件操作时的根目录。</mark>

```python
import os
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset, StdioServerParameters

# Create a reliable absolute path to a folder named 'mcp_managed_files'
# within the same directory as this agent script.
# This ensures the agent works out-of-the-box for demonstration.
# For production, you would point this to a more persistent and secure location.
# 创建一个可靠的绝对路径，指向与这个 agent 脚本同目录下的 'mcp_managed_files' 文件夹。
# 这样确保 agent 能够直接工作，无需修改路径配置。
# 在生产环境中，应该指向一个更持久和安全的存储位置。
TARGET_FOLDER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp_managed_files")

# Ensure the target directory exists before the agent needs it.
# 确保目标目录在 agent 需要使用之前就存在。
os.makedirs(TARGET_FOLDER_PATH, exist_ok=True)

root_agent = LlmAgent(
   model='gemini-2.0-flash',
   name='filesystem_assistant_agent',
   instruction=(
       'Help the user manage their files. You can list files, read files, and write files. '
       f'You are operating in the following directory: {TARGET_FOLDER_PATH}'
   ),
   tools=[
       MCPToolset(
           connection_params=StdioServerParameters(
               command='npx',
               args=[
                   "-y",  # Argument for npx to auto-confirm install
                   "@modelcontextprotocol/server-filesystem",
                   # This MUST be an absolute path to a folder.
                   TARGET_FOLDER_PATH,
               ],
           ),
           # Optional: You can filter which tools from the MCP server are exposed.
           # For example, to only allow reading:
           # tool_filter=['list_directory', 'read_file']
           # 可选：你可以过滤 MCP 服务器暴露的工具。
           # 例如，只允许读取文件：
           # tool_filter=['list_directory', 'read_file']
       )
   ],
)
```

`npx` (Node Package Execute), bundled with npm (Node Package Manager) versions 5.2.0 and later, is a utility that enables direct execution of Node.js packages from the npm registry. This eliminates the need for global installation. In essence, `npx` serves as an npm package runner, and it is commonly used to run many community MCP servers, which are distributed as Node.js packages.

<mark><code>npx</code>（Node Package Execute）是 npm 5.2.0 及更高版本内置的工具，能够直接运行 npm registry 中的 Node.js 包，无需全局安装。它本质上是一个 npm 包运行器，常用于运行以 Node.js 包形式发布的社区 MCP 服务器。</mark>

Creating an **init**.py file is necessary to ensure the agent.py file is recognized as part of a discoverable Python package for the Agent Development Kit (ADK). This file should reside in the same directory as agent.py.

<mark>为了让智能体开发套件（ADK）能够正确识别 <code>agent.py</code> 文件作为可发现的 Python 包，我们需要创建一个 <code>__init__.py</code> 文件。这个文件需要和 <code>agent.py</code> 放在同一个目录下。</mark>

```python
# ./adk_agent_samples/mcp_agent/__init__.py
from . import agent
```

Certainly, other supported commands are available for use. For example, connecting to python3 can be achieved as follows:

<mark>当然，还有其他支持的命令可供使用。例如，可以按如下方式连接到 <code>python3</code>：</mark>

```python
connection_params = StdioConnectionParams(
 server_params={
     "command": "python3",
     "args": ["./agent/mcp_server.py"],
     "env": {
       "SERVICE_ACCOUNT_PATH":SERVICE_ACCOUNT_PATH,
       "DRIVE_FOLDER_ID": DRIVE_FOLDER_ID
     }
 }
)
```

UVX, in the context of Python, refers to a command-line tool that utilizes uv to execute commands in a temporary, isolated Python environment. Essentially, it allows you to run Python tools and packages without needing to install them globally or within your project's environment. You can run it via the MCP server.

<mark>在 Python 上下文中，UVX 是基于 uv 的命令行工具，用于在临时隔离的 Python 环境中执行命令。它允许直接运行 Python 工具和包，无需全局安装或影响项目环境，并可通过 MCP 服务器调用。</mark>

```python
connection_params = StdioConnectionParams(
 server_params={
   "command": "uvx",
   "args": ["mcp-google-sheets@latest"],
   "env": {
     "SERVICE_ACCOUNT_PATH":SERVICE_ACCOUNT_PATH,
     "DRIVE_FOLDER_ID": DRIVE_FOLDER_ID
   }
 }
)
```

Once the MCP Server is created, the next step is to connect to it.

<mark>现在 MCP 服务器已经搭建完成，下一步就是建立连接了。</mark>

### Connecting the MCP Server with ADK Web | <mark>使用 ADK Web 连接 MCP 服务器</mark>

To begin, execute 'adk web'. Navigate to the parent directory of mcp_agent (e.g., adk_agent_samples) in your terminal and run:

<mark>首先，执行「adk web」。在终端中导航到 <code>mcp_agent</code> 的父目录（例如 <code>adk_agent_samples</code>）并运行：</mark>

```bash
cd ./adk_agent_samples # Or your equivalent parent directory
adk web
```

Once the ADK Web UI has loaded in your browser, select the `filesystem_assistant_agent` from the agent menu. Next, experiment with prompts such as:

<mark>等浏览器里显示出 ADK Web 的操作界面后，从智能体菜单里选择 <code>filesystem_assistant_agent</code>。接下来你可以试试下面这些指令：</mark>

- "Show me the contents of this folder."
- "Read the `sample.txt` file." (This assumes `sample.txt` is located at `TARGET_FOLDER_PATH`.)
- "What's in `another_file.md`?"

- <mark>「显示此文件夹的内容。」</mark>
- <mark>「读取 <code>sample.txt</code> 文件。」（假设 <code>sample.txt</code> 位于 <code>TARGET_FOLDER_PATH</code>。）</mark>
- <mark>「<code>another_file.md</code> 里有什么？」</mark>

------

## Creating an MCP Server with FastMCP | <mark>使用 FastMCP 创建 MCP 服务器</mark>

FastMCP is a high-level Python framework designed to streamline the development of MCP servers. It provides an abstraction layer that simplifies protocol complexities, allowing developers to focus on core logic.

<mark>FastMCP 是一个专门为简化 MCP 服务器开发而设计的高级 Python 框架。它通过提供抽象层来封装协议的复杂性，让开发者能够把精力集中在核心业务逻辑上。</mark>

The library enables rapid definition of tools, resources, and prompts using simple Python decorators. A significant advantage is its automatic schema generation, which intelligently interprets Python function signatures, type hints, and documentation strings to construct necessary AI model interface specifications. This automation minimizes manual configuration and reduces human error.

<mark>这个库最大的特点是可以用简单的 Python 装饰器来快速定义工具、资源和提示模板。特别值得一提的是它的模式自动生成功能，它会智能地解析 Python 函数的签名、类型注解和文档字符串，自动生成 AI 模型所需的接口规范，这种自动化机制大大减少了手动配置的工作量，也降低了出错的可能性。</mark>

Beyond basic tool creation, FastMCP facilitates advanced architectural patterns like server composition and proxying. This enables modular development of complex, multi-component systems and seamless integration of existing services into an AI-accessible framework. Additionally, FastMCP includes optimizations for efficient, distributed, and scalable AI-driven applications.

<mark>除了基础的工具创建功能，FastMCP 还支持像服务器组合和代理这样的高级架构模式。这意味着你可以用模块化的方式开发复杂的多组件系统，还能把现有的服务无缝对接到 AI 可访问的框架里。另外，FastMCP 还内置了对高效、分布式、可扩展的 AI 驱动应用的优化支持。</mark>

### Server setup with FastMCP | <mark>使用 FastMCP 设置服务器</mark>

To illustrate, consider a basic "greet" tool provided by the server. ADK agents and other MCP clients can interact with this tool using HTTP once it is active.

<mark>举个简单的例子，假设服务器提供了一个基础的「问候」功能。等服务器启动运行后，ADK 智能体和其他 MCP 客户端就能通过 HTTP 协议来调用这个功能了。</mark>

```python
# fastmcp_server.py
# This script demonstrates how to create a simple MCP server using FastMCP.
# It exposes a single tool that generates a greeting.
# 这个脚本演示了如何使用 FastMCP 创建一个简单的 MCP 服务器。
# 它暴露了一个名为 'greet' 的工具，用于生成个性化问候语。

# 1. Make sure you have FastMCP installed:
# pip install fastmcp
# 确保你已经安装了 FastMCP：
# pip install fastmcp
from fastmcp import FastMCP, Client

# Initialize the FastMCP server.
# 初始化 FastMCP 服务器。
mcp_server = FastMCP()

# Define a simple tool function.
# The `@mcp_server.tool` decorator registers this Python function as an MCP tool.
# The docstring becomes the tool's description for the LLM.
# 这个装饰器将 greet 函数注册为 MCP 工具。
# 函数的注释将成为 LLM 看到的工具描述。
@mcp_server.tool
def greet(name: str) -> str:
    """
    Generates a personalized greeting.

    Args:
        name: The name of the person to greet.

    Returns:
        A greeting string.
    """
    return f"Hello, {name}! Nice to meet you."

# Or if you want to run it from the script:
# 或者如果你想从脚本运行它：
if __name__ == "__main__":
    mcp_server.run(
        transport="http",
        host="127.0.0.1",
        port=8000
    )
```

This Python script defines a single function called greet, which takes a person's name and returns a personalized greeting. The @tool() decorator above this function automatically registers it as a tool that an AI or another program can use. The function's documentation string and type hints are used by FastMCP to tell the Agent how the tool works, what inputs it needs, and what it will return.

<mark>这个 Python 脚本定义了一个名为 <code>greet</code> 的函数，根据人名生成个性化问候语。函数上方的 <code>@tool()</code> 装饰器会自动将其注册为 AI 或其他程序可调用的工具。FastMCP 利用函数的注释以及类型注解，自动告知智能体工具的使用方法、所需参数和返回结果。</mark>

When the script is executed, it starts the FastMCP server, which listens for requests on localhost:8000. This makes the greet function available as a network service. An agent could then be configured to connect to this server and use the greet tool to generate greetings as part of a larger task. The server runs continuously until it is manually stopped.

<mark>运行此脚本时，会启动一个 FastMCP 服务器，在 localhost:8000 监听请求。这样 <code>greet</code> 函数就成为可通过网络访问的服务。我们可以配置智能体连接到此服务器，在完成复杂任务的过程中调用问候功能。服务器将持续运行，直到手动停止。</mark>

### Consuming the FastMCP Server with an ADK Agent | <mark>使用 ADK 智能体连接 FastMCP 服务器</mark>

An ADK agent can be set up as an MCP client to use a running FastMCP server. This requires configuring HttpServerParameters with the FastMCP server's network address, which is usually [http://localhost:8000](http://localhost:8000/).

<mark>可以将 ADK 智能体配置为 MCP 客户端，使其能够使用正在运行的 FastMCP 服务器。具体做法是用 FastMCP 服务器的网络地址（通常是 <code>http://localhost:8000</code>）来配置 <code>HttpServerParameters</code>。</mark>

A tool_filter parameter can be included to restrict the agent's tool usage to specific tools offered by the server, such as 'greet'. When prompted with a request like "Greet John Doe," the agent's embedded LLM identifies the 'greet' tool available via MCP, invokes it with the argument "John Doe," and returns the server's response. This process demonstrates the integration of user-defined tools exposed through MCP with an ADK agent.

<mark>还可以添加 <code>tool_filter</code> 参数，限制智能体只能使用服务器提供的特定工具，比如 <code>greet</code> 问候功能。当用户发出「问候 John Doe」这样的请求时，智能体内置的大语言模型会识别通过 MCP 可用的 <code>greet</code> 工具，用「John Doe」作为参数调用，最后将服务器响应返回给用户。这展示了如何将通过 MCP 暴露的自定义工具集成到 ADK 智能体。</mark>

To establish this configuration, an agent file (e.g., agent.py located in ./adk_agent_samples/fastmcp_client_agent/) is required. This file will instantiate an ADK agent and use HttpServerParameters to establish a connection with the operational FastMCP server.

<mark>要实现这样的配置，我们需要准备一个智能体配置文件（比如放在 <code>./adk_agent_samples/fastmcp_client_agent/</code> 目录下的  <code>agent.py</code>）。这个文件会创建一个 ADK 智能体实例，并通过 <code>HttpServerParameters</code> 来和正在运行的 FastMCP 服务器建立连接。</mark>

```python
# ./adk_agent_samples/fastmcp_client_agent/agent.py
import os
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset, HttpServerParameters

# Define the FastMCP server's address.
# Make sure your fastmcp_server.py (defined previously) is running on this port.
# 定义 FastMCP 服务器的地址。
# 确保 fastmcp_server.py（前面定义的）正在这个端口上运行。
FASTMCP_SERVER_URL = "http://localhost:8000"

root_agent = LlmAgent(
   model='gemini-2.0-flash', # Or your preferred model
   name='fastmcp_greeter_agent',
   instruction='You are a friendly assistant that can greet people by their name. Use the "greet" tool.',
   tools=[
       MCPToolset(
           connection_params=HttpServerParameters(
               url=FASTMCP_SERVER_URL,
           ),
           # Optional: Filter which tools from the MCP server are exposed
           # For this example, we're expecting only 'greet'
           # 可选：过滤 MCP 服务器暴露的工具。
           # 例如，只允许读取文件：
           # tool_filter=['list_directory', 'read_file']
           tool_filter=['greet']
       )
   ],
)
```

The script defines an Agent named fastmcp_greeter_agent that uses a Gemini language model. It's given a specific instruction to act as a friendly assistant whose purpose is to greet people. Crucially, the code equips this agent with a tool to perform its task. It configures an MCPToolset to connect to a separate server running on localhost:8000, which is expected to be the FastMCP server from the previous example. The agent is specifically granted access to the greet tool hosted on that server. In essence, this code sets up the client side of the system, creating an intelligent agent that understands its goal is to greet people and knows exactly which external tool to use to accomplish it.

<mark>该脚本定义了一个名为 <code>fastmcp_greeter_agent</code> 的智能体，基于 Gemini 模型。智能体被设定为友好助手，专门负责问候用户。代码为其配备了执行任务所需的工具——配置 <code>MCPToolset</code> 连接到运行在 <code>localhost:8000</code> 的独立服务器，即前面示例中的 FastMCP 服务器。智能体被授权使用该服务器上的 <code>greet</code> 问候工具。这段代码搭建了系统的客户端部分，创建了一个明确任务目标并知晓所需外部工具的智能体。</mark>

Creating an **init**.py file within the fastmcp_client_agent directory is necessary. This ensures the agent is recognized as a discoverable Python package for the ADK.

<mark>需要在 <code>fastmcp_client_agent</code> 目录下创建一个 <code>__init__.py</code> 文件，以确保 ADK 能将智能体识别为可发现的 Python 包。</mark>

To begin, open a new terminal and run `python fastmcp_server.py` to start the FastMCP server. Next, go to the parent directory of `fastmcp_client_agent` (for example, `adk_agent_samples`) in your terminal and execute `adk web`. Once the ADK Web UI loads in your browser, select the `fastmcp_greeter_agent` from the agent menu. You can then test it by entering a prompt like "Greet John Doe." The agent will use the `greet` tool on your FastMCP server to create a response.

<mark>具体操作步骤：首先打开新终端窗口，运行 <code>python fastmcp_server.py</code> 启动 FastMCP 服务器。然后在终端中进入 <code>fastmcp_client_agent</code> 的上级目录（例如 <code>adk_agent_samples</code>），执行 <code>adk web</code> 命令。待浏览器显示 ADK Web 界面后，从智能体菜单中选择 <code>fastmcp_greeter_agent</code>。此时可输入「问候 John Doe」这样的指令进行测试，智能体将调用 FastMCP 服务器上的 <code>greet</code> 工具生成响应。</mark>

------

## At a Glance | <mark>要点速览</mark>

**What:** To function as effective agents, LLMs must move beyond simple text generation. They require the ability to interact with the external environment to access current data and utilize external software. Without a standardized communication method, each integration between an LLM and an external tool or data source becomes a custom, complex, and non-reusable effort. This ad-hoc approach hinders scalability and makes building complex, interconnected AI systems difficult and inefficient.

<mark><strong>问题所在：</strong>要让大语言模型真正成为有效的智能体，它们不能只停留在文本生成层面，还需要具备与外部环境交互的能力，既能获取实时数据，又能调用外部软件。如果没有统一的通信标准，每次把大语言模型和外部工具或数据源对接都要从头定制开发，既复杂又难以复用。这种临时凑合的做法严重限制了系统的扩展性，也让构建复杂互联的 AI 系统变得异常困难和低效。</mark>

**Why:** The Model Context Protocol (MCP) offers a standardized solution by acting as a universal interface between LLMs and external systems. It establishes an open, standardized protocol that defines how external capabilities are discovered and used. Operating on a client-server model, MCP allows servers to expose tools, data resources, and interactive prompts to any compliant client. LLM-powered applications act as these clients, dynamically discovering and interacting with available resources in a predictable manner. This standardized approach fosters an ecosystem of interoperable and reusable components, dramatically simplifying the development of complex agentic workflows.

<mark><strong>解决之道：</strong>模型上下文协议（MCP）提供了一个标准化的解决方案，它就像是大语言模型和外部系统之间的通用接口。这个开放的标准化协议明确定义了如何发现和使用外部能力。MCP 采用「客户端 - 服务器」架构，让服务器能够向所有兼容的客户端提供工具、数据资源和交互提示。由大语言模型驱动的应用作为客户端，可以按需发现并使用这些资源，整个过程都是可预测的。这种标准化方式促成了一个可互操作、可复用组件的生态系统，大大简化了复杂智能体工作流的开发难度。</mark>

**Rule of thumb:** Use the Model Context Protocol (MCP) when building complex, scalable, or enterprise-grade agentic systems that need to interact with a diverse and evolving set of external tools, data sources, and APIs. It is ideal when interoperability between different LLMs and tools is a priority, and when agents require the ability to dynamically discover new capabilities without being redeployed. For simpler applications with a fixed and limited number of predefined functions, direct tool function calling may be sufficient.

<mark><strong>经验法则：</strong>当你需要构建复杂、可扩展的企业级智能体系统，而且这些系统要和各种各样的外部工具、数据源、API 打交道时，就应该考虑使用 MCP 协议。特别是在不同大语言模型和工具之间的互操作性很重要，或者智能体需要动态发现新功能而不用重新部署的情况下，MCP 是最佳选择。但如果你的应用比较简单，只需要调用有限几个固定功能，那直接用工具函数调用可能就够用了。</mark>

**Visual summary** | <mark><strong>可视化总结</strong></mark>

![Model Context protocol](/images/chapter10_fig1.png)

Fig.1: Model Context protocol

<mark><strong>图 1：</strong>模型上下文协议</mark>

------

## Key Takeaways | <mark>核心要点</mark>

These are the key takeaways:

<mark>以下是核心要点：</mark>

- The Model Context Protocol (MCP) is an open standard facilitating standardized communication between LLMs and external applications, data sources, and tools.

   <mark>模型上下文协议（MCP）是一个开放标准，它为大语言模型和外部应用、数据源、工具之间的通信提供了统一的规范。</mark>

- It employs a client-server architecture, defining the methods for exposing and consuming resources, prompts, and tools.

   <mark>这个协议采用「客户端 - 服务器」架构，明确定义了如何对外提供和使用各种资源、提示模板和工具。</mark>

- The Agent Development Kit (ADK) supports both utilizing existing MCP servers and exposing ADK tools via an MCP server.

   <mark>智能体开发套件（ADK）既支持连接现有的 MCP 服务器，也支持把 ADK 里的工具通过 MCP 服务器对外提供。</mark>

- FastMCP simplifies the development and management of MCP servers, particularly for exposing tools implemented in Python.

   <mark>FastMCP 这个框架让 MCP 服务器的开发和管理变得更简单，特别适合把用 Python 写的工具封装成服务。</mark>

- MCP Tools for Genmedia Services allows agents to integrate with Google Cloud's generative media capabilities (Imagen, Veo, Chirp 3 HD, Lyria).

   <mark>通过媒体生成服务 MCP 工具，智能体可以很方便地调用 Google Cloud 的各种生成式媒体能力，比如 Imagen、Veo、Chirp 3 HD 和 Lyria。</mark>

- MCP enables LLMs and agents to interact with real-world systems, access dynamic information, and perform actions beyond text generation.

   <mark>MCP 让大语言模型和智能体不再局限于文本生成，而是能够真正与现实世界系统交互，获取动态信息，执行具体操作。</mark>

------

## Conclusion | <mark>结语</mark>

The Model Context Protocol (MCP) is an open standard that facilitates communication between Large Language Models (LLMs) and external systems. It employs a client-server architecture, enabling LLMs to access resources, utilize prompts, and execute actions through standardized tools. MCP allows LLMs to interact with databases, manage generative media workflows, control IoT devices, and automate financial services. Practical examples demonstrate setting up agents to communicate with MCP servers, including filesystem servers and servers built with FastMCP, illustrating its integration with the Agent Development Kit (ADK). MCP is a key component for developing interactive AI agents that extend beyond basic language capabilities.

<mark>模型上下文协议（MCP）是一个开放标准，它为大语言模型和外部系统之间的通信提供了一套通用规范。这个协议采用「客户端 - 服务器」架构，使 LLM 能够通过标准化工具访问资源、利用提示词并执行操作。MCP 允许 LLM 与数据库交互、管理生成式媒体工作流、控制物联网设备以及自动化金融服务。实际示例演示了设置智能体与 MCP 服务器通信，包括文件系统服务器和使用 FastMCP 构建的服务器，说明了其与智能体开发套件（ADK）的集成。MCP 是开发扩展到基本语言能力之外的交互式 AI 智能体的关键组件。</mark>

------

## References | <mark>参考文献</mark>

1. Model Context Protocol (MCP) Documentation. (Latest). Model Context Protocol (MCP). [https://google.github.io/adk-docs/mcp/](https://google.github.io/adk-docs/mcp/)

   <mark>1. 模型上下文协议（MCP）文档（最新版本）。[https://google.github.io/adk-docs/mcp/](https://google.github.io/adk-docs/mcp/)</mark>

2. FastMCP Documentation. FastMCP. [https://github.com/jlowin/fastmcp](https://github.com/jlowin/fastmcp)

   <mark>2. FastMCP 文档。[https://github.com/jlowin/fastmcp](https://github.com/jlowin/fastmcp)</mark>

3. MCP Tools for Genmedia Services. MCP Tools for Genmedia Services. [https://google.github.io/adk-docs/mcp/#mcp-servers-for-google-cloud-genmedia](https://google.github.io/adk-docs/mcp/#mcp-servers-for-google-cloud-genmedia)

   <mark>3. 媒体生成服务 MCP 工具。[https://google.github.io/adk-docs/mcp/#mcp-servers-for-google-cloud-genmedia](https://google.github.io/adk-docs/mcp/#mcp-servers-for-google-cloud-genmedia)</mark>

4. MCP Toolbox for Databases Documentation. (Latest). MCP Toolbox for Databases. [https://google.github.io/adk-docs/mcp/databases/](https://google.github.io/adk-docs/mcp/databases/)

   <mark>4. 数据库 MCP 工具文档。（最新版本）[https://google.github.io/adk-docs/mcp/databases/](https://google.github.io/adk-docs/mcp/databases/)</mark>