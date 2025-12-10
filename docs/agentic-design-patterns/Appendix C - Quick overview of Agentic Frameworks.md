# Appendix C - Quick overview of Agentic Frameworks | <mark>附录C: 智能体框架快速概览</mark>


## LangChain 

LangChain is a framework for developing applications powered by LLMs. Its core strength lies in its LangChain Expression Language (LCEL), which allows you to "pipe" components together into a chain. This creates a clear, linear sequence where the output of one step becomes the input for the next. It's built for workflows that are Directed Acyclic Graphs (DAGs), meaning the process flows in one direction without loops.

<mark>LangChain是用于开发基于大语言模型(LLM)的应用程序框架。它的核心优势在于其LangChain表达式语言(LCEL)，该语言允许您将组件“串联”成链。这创建了清晰的线性序列，其中上一步的输出成为下一步的输入。它专为有向无环图(DAG)工作流而设计，这意味着流程沿一个方向流动，没有循环。</mark>

Use it for: <mark>用途：</mark>

●  Simple RAG: Retrieve a document, create a prompt, get an answer from an LLM.

<mark>简单 RAG：检索文档，创建提示，从LLM获取答案。</mark>

●  Summarization: Take user text, feed it to a summarization prompt, and return the output.

<mark>摘要：获取用户文本，将其输入摘要提示，并返回输出结果。</mark>

●  Extraction: Extract structured data (like JSON) from a block of text.

<mark>提取：从文本块中提取结构化数据（例如JSON）。</mark>

Python
```python
# A simple LCEL chain conceptually
# (This is not runnable code, just illustrates the flow)
chain = prompt | model | output_parse
```

## LangGraph

LangGraph is a library built on top of LangChain to handle more advanced agentic systems. It allows you to define your workflow as a graph with nodes (functions or LCEL chains) and edges (conditional logic). Its main advantage is the ability to create cycles, allowing the application to loop, retry, or call tools in a flexible order until a task is complete. It explicitly manages the application state, which is passed between nodes and updated throughout the process.

<mark>LangGraph是基于LangChain构建的库，用于处理更高级的智能体系统。它允许您将工作流定义为图，该图由节点（函数或LCEL链）和边（条件逻辑）组成。其主要优势在于能够创建循环，从而允许应用程序以灵活的顺序循环、重试或调用工具，直到任务完成。它显式地管理应用程序状态，该状态在节点之间传递并在整个过程中更新。</mark>

Use it for: <mark>用途：</mark>

●  Multi-agent Systems: A supervisor agent routes tasks to specialized worker agents, potentially looping until the goal is met.

<mark>多智能体系统：主管智能体将任务分配给专门的工作智能体，可能会循环执行，直到达到目标。</mark>

●  Plan-and-Execute Agents: An agent creates a plan, executes a step, and then loops back to update the plan based on the result.

<mark>计划执行智能体：智能体创建计划，执行步骤，然后循环返回并根据结果更新计划。</mark>

●  Human-in-the-Loop: The graph can wait for human input before deciding which node to go to next.

<mark>人机交互：该图可以等待人工输入，然后再决定下一步要访问哪个节点。</mark>

| Feature | LangChain | LangGraph |
|---------|------|------|
| Core Abstraction | Chain (using LCEL) | Graph of Nodes |
| Workflow Type | Linear (Directed Acyclic Graph) | Cyclical (Graphs with loops) |
| State Management | Generally stateless per run | Explicit and persistent state object |
| Primary Use | Simple, predictable sequences | Complex, dynamic, stateful agents |

Which One Should You Use? <mark>你应该使用哪一个？</mark>

●  Choose LangChain when your application has a clear, predictable, and linear flow of steps. If you can define the process from A to B to C without needing to loop back, LangChain with LCEL is the perfect tool.

<mark>如果您的应用流程清晰、可预测且呈线性发展，那么LangChain是您的理想之选。如果您可以定义从A到B、再到C的完整流程而无需循环，那么LangChain与LCEL结合使用将是您的完美选择。</mark>

●  Choose LangGraph when you need your application to reason, plan, or operate in a loop. If your agent needs to use tools, reflect on the results, and potentially try again with a different approach, you need the cyclical and stateful nature of LangGraph.

<mark>当您的应用程序需要进行推理、规划或循环操作时，请选择LangGraph。如果您的智能体需要使用工具、反思结果，并可能尝试不同的方法，那么您就需要LangGraph的循环性和有状态特性。</mark>

Python
```python
# Graph state
class State(TypedDict):
   topic: str
   joke: str
   story: str
   poem: str
   combined_output: str

# Nodes
def call_llm_1(state: State):
   """First LLM call to generate initial joke"""

   msg = llm.invoke(f"Write a joke about {state['topic']}")
   return {"joke": msg.content}

def call_llm_2(state: State):
   """Second LLM call to generate story"""

   msg = llm.invoke(f"Write a story about {state['topic']}")
   return {"story": msg.content}

def call_llm_3(state: State):
   """Third LLM call to generate poem"""

   msg = llm.invoke(f"Write a poem about {state['topic']}")
   return {"poem": msg.content}

def aggregator(state: State):
   """Combine the joke and story into a single output"""

   combined = f"Here's a story, joke, and poem about {state['topic']}!\n\n"
   combined += f"STORY:\n{state['story']}\n\n"
   combined += f"JOKE:\n{state['joke']}\n\n"
   combined += f"POEM:\n{state['poem']}"
   return {"combined_output": combined}

# Build workflow
parallel_builder = StateGraph(State)

# Add nodes
parallel_builder.add_node("call_llm_1", call_llm_1)
parallel_builder.add_node("call_llm_2", call_llm_2)
parallel_builder.add_node("call_llm_3", call_llm_3)
parallel_builder.add_node("aggregator", aggregator)

# Add edges to connect nodes
parallel_builder.add_edge(START, "call_llm_1")
parallel_builder.add_edge(START, "call_llm_2")
parallel_builder.add_edge(START, "call_llm_3")
parallel_builder.add_edge("call_llm_1", "aggregator")
parallel_builder.add_edge("call_llm_2", "aggregator")
parallel_builder.add_edge("call_llm_3", "aggregator")
parallel_builder.add_edge("aggregator", END)
parallel_workflow = parallel_builder.compile()

# Show workflow
display(Image(parallel_workflow.get_graph().draw_mermaid_png()))

# Invoke
state = parallel_workflow.invoke({"topic": "cats"})
print(state["combined_output"])
```


## Google's ADK

Google's Agent Development Kit, or ADK, provides a high-level, structured framework for building and deploying applications composed of multiple, interacting AI agents. It contrasts with LangChain and LangGraph by offering a more opinionated and production-oriented system for orchestrating agent collaboration, rather than providing the fundamental building blocks for an agent's internal logic.

<mark>谷歌智能体开发工具包（ADK）提供了高级的结构化框架，用于构建和部署由多个交互AI智能体组成的应用程序。与LangChain和LangGraph不同，ADK提供了更具规范性和面向生产环境的系统来协调智能体之间的协作，而不是提供智能体内部逻辑的基本构建模块。</mark>

LangChain operates at the most foundational level, offering the components and standardized interfaces to create sequences of operations, such as calling a model and parsing its output. LangGraph extends this by introducing a more flexible and powerful control flow; it treats an agent's workflow as a stateful graph. Using LangGraph, a developer explicitly defines nodes, which are functions or tools, and edges, which dictate the path of execution. This graph structure allows for complex, cyclical reasoning where the system can loop, retry tasks, and make decisions based on an explicitly managed state object that is passed between nodes. It gives the developer fine-grained control over a single agent's thought process or the ability to construct a multi-agent system from first principles.

<mark>LangChain在最基础的层面上运行，提供创建操作序列所需的组件和标准化接口，例如调用模型并解析其输出。LangGraph在此基础上扩展了功能，引入了更灵活、更强大的控制流；它将智能体的工作流程视为有状态图。使用LangGraph，开发者可以显式地定义节点（即函数或工具）和边（即执行路径）。这种图结构支持复杂的循环推理，系统可以循环执行、重试任务，并基于在节点之间传递的显式管理的状态对象做出决策。它使开发者能够对单个智能体的思维过程进行细粒度控制，或者从零开始构建多智能体系统。</mark>

Google's ADK abstracts away much of this low-level graph construction. Instead of asking the developer to define every node and edge, it provides pre-built architectural patterns for multi-agent interaction. For instance, ADK has built-in agent types like SequentialAgent or ParallelAgent, which manage the flow of control between different agents automatically. It is architected around the concept of a "team" of agents, often with a primary agent delegating tasks to specialized sub-agents. State and session management are handled more implicitly by the framework, providing a more cohesive but less granular approach than LangGraph's explicit state passing. Therefore, while LangGraph gives you the detailed tools to design the intricate wiring of a single robot or a team, Google's ADK gives you a factory assembly line designed to build and manage a fleet of robots that already know how to work together.

<mark>Google ADK抽象化了许多底层图构建工作。它无需开发者定义每个节点和边，而是提供了预构建的多智能体交互架构模式。例如，ADK内置了SequentialAgent或ParallelAgent等智能体类型，可以自动管理不同智能体之间的控制流。它的架构围绕着智能体“团队”的概念展开，通常由一个主智能体将任务委派给专门的子智能体。框架以更隐式的方式处理状态和会话管理，提供了一种比LangGraph的显式状态传递更统一但粒度更低的方法。因此，LangGraph提供了设计单个机器人或团队复杂线路的详细工具，而Google ADK 则提供了一条工厂装配线，用于构建和管理一支已经知道如何协同工作的机器人集群。</mark>

Python
```python
from google.adk.agents import LlmAgent
from google.adk.tools import google_Search

dice_agent = LlmAgent(
   model="gemini-2.0-flash-exp", 
   name="question_answer_agent",
   description="A helpful assistant agent that can answer questions.",
   instruction="""Respond to the query using google search""",
   tools=[google_search],
)
```
This code creates a search-augmented agent. When this agent receives a question, it will not just rely on its pre-existing knowledge. Instead, following its instructions, it will use the Google Search tool to find relevant, real-time information from the web and then use that information to construct its answer.

<mark>这段代码创建了搜索增强型智能体。当该智能体接收到问题时，它不会仅仅依赖其已有的知识。相反，它会按照指令，使用谷歌搜索工具从网络上查找相关的实时信息，然后利用这些信息构建答案。</mark>

## Crew.AI

CrewAI offers an orchestration framework for building multi-agent systems by focusing on collaborative roles and structured processes. It operates at a higher level of abstraction than foundational toolkits, providing a conceptual model that mirrors a human team. Instead of defining the granular flow of logic as a graph, the developer defines the actors and their assignments, and CrewAI manages their interaction.

<mark>CrewAI 提供了编排框架用于构建多智能体系统，其核心在于协作角色和结构化流程。与基础工具包相比，CrewAI 的抽象层次更高，提供了一个类似于人类团队的概念模型。开发者无需将细粒度的逻辑流程定义为图，只需定义参与者及其任务，CrewAI便会负责管理它们之间的交互。</mark>

The core components of this framework are Agents, Tasks, and the Crew. An Agent is defined not just by its function but by a persona, including a specific role, a goal, and a backstory, which guides its behavior and communication style. A Task is a discrete unit of work with a clear description and expected output, assigned to a specific Agent. The Crew is the cohesive unit that contains the Agents and the list of Tasks, and it executes a predefined Process. This process dictates the workflow, which is typically either sequential, where the output of one task becomes the input for the next in line, or hierarchical, where a manager-like agent delegates tasks and coordinates the workflow among other agents.

<mark>该框架的核心组成部分包括智能体（Agent）、任务（Task）和团队（Crew）。智能体的定义不仅取决于其功能，还取决于其角色，包括具体角色、目标和背景故事，这些因素共同指导其行为和沟通方式。任务是一个独立的工作单元，具有清晰的描述和预期输出，并分配给特定的智能体。团队是一个包含所有智能体和任务列表的凝聚单元，它执行预定义的流程。该流程决定了工作流程，通常分为顺序式和层级式两种。顺序式工作流程中，一个任务的输出成为下一个任务的输入；层级式工作流程中，一个类似经理的智能体负责分配任务并协调其他智能体之间的工作流程。</mark>

When compared to other frameworks, CrewAI occupies a distinct position. It moves away from the low-level, explicit state management and control flow of LangGraph, where a developer wires together every node and conditional edge. Instead of building a state machine, the developer designs a team charter. While Googlés ADK provides a comprehensive, production-oriented platform for the entire agent lifecycle, CrewAI concentrates specifically on the logic of agent collaboration and for simulating a team of specialists.

<mark>与其他框架相比，CrewAI占据着独特的地位。它摒弃了LangGraph那种底层、显式的状态管理和控制流；在LangGraph中，开发者需要将每个节点和条件边连接起来。CrewAI的开发者无需构建状态机，而是设计团队章程。虽然Google ADK 为整个智能体生命周期提供了一个全面、面向生产的平台，但CrewAI则专注于智能体协作逻辑以及专家团队的模拟。</mark>

Python
```python
@crew
def crew(self) -> Crew:
   """Creates the research crew"""
   return Crew(
     agents=self.agents,
     tasks=self.tasks,
     process=Process.sequential,
     verbose=True,
   )
```

This code sets up a sequential workflow for a team of AI agents, where they tackle a list of tasks in a specific order, with detailed logging enabled to monitor their progress.

<mark>这段代码为一组AI智能体设置了顺序工作流程，它们按特定顺序处理一系列任务，并启用了详细的日志记录来监控它们的进度。</mark>

## Other agent development framework | <mark>其他智能体开发框架</mark>

Microsoft AutoGen: AutoGen is a framework centered on orchestrating multiple agents that solve tasks through conversation. Its architecture enables agents with distinct capabilities to interact, allowing for complex problem decomposition and collaborative resolution. The primary advantage of AutoGen is its flexible, conversation-driven approach that supports dynamic and complex multi-agent interactions. However, this conversational paradigm can lead to less predictable execution paths and may require sophisticated prompt engineering to ensure tasks converge efficiently.

<mark>Microsoft AutoGen：AutoGen是以协调多个智能体通过对话解决任务为核心的框架。其架构允许具有不同能力的智能体进行交互，从而实现复杂问题的分解和协作解决。AutoGen的主要优势在于其灵活的、对话驱动的方法，支持动态且复杂的多智能体交互。然而，这种对话模式可能会导致执行路径难以预测，并且可能需要复杂的提示工程来确保任务高效收敛。</mark>

LlamaIndex: LlamaIndex is fundamentally a data framework designed to connect large language models with external and private data sources. It excels at creating sophisticated data ingestion and retrieval pipelines, which are essential for building knowledgeable agents that can perform RAG. While its data indexing and querying capabilities are exceptionally powerful for creating context-aware agents, its native tools for complex agentic control flow and multi-agent orchestration are less developed compared to agent-first frameworks. LlamaIndex is optimal when the core technical challenge is data retrieval and synthesis.

<mark>LlamaIndex：LlamaIndex本质上是一个旨在连接大型语言模型与外部和私有数据源的数据框架。它擅长构建复杂的数据摄取和检索管道，这对于构建能够执行RAG（红、红、绿）任务的知识型智能体至关重要。虽然其数据索引和查询功能对于创建上下文感知智能体来说非常强大，但与以智能体为先导的框架相比，其用于复杂智能体控制流和多智能体编排的原生工具尚不完善。当核心技术挑战在于数据检索和合成时，LlamaIndex是最佳选择。</mark>

Haystack: Haystack is an open-source framework engineered for building scalable and production-ready search systems powered by language models. Its architecture is composed of modular, interoperable nodes that form pipelines for document retrieval, question answering, and summarization. The main strength of Haystack is its focus on performance and scalability for large-scale information retrieval tasks, making it suitable for enterprise-grade applications. A potential trade-off is that its design, optimized for search pipelines, can be more rigid for implementing highly dynamic and creative agentic behaviors.

<mark>Haystack：Haystack是专为构建可扩展且可用于生产环境的、基于语言模型的搜索系统而设计的开源框架。其架构由模块化、可互操作的节点组成，这些节点构成文档检索、问答和摘要的管道。Haystack的主要优势在于其专注于大规模信息检索任务的性能和可扩展性，使其适用于企业级应用。但其潜在的不足之处在于，其针对搜索管道优化的设计可能较为僵化，难以实现高度动态和创造性的智能体行为。</mark>

MetaGPT: MetaGPT implements a multi-agent system by assigning roles and tasks based on a predefined set of Standard Operating Procedures (SOPs). This framework structures agent collaboration to mimic a software development company, with agents taking on roles like product managers or engineers to complete complex tasks. This SOP-driven approach results in highly structured and coherent outputs, which is a significant advantage for specialized domains like code generation. The framework's primary limitation is its high degree of specialization, making it less adaptable for general-purpose agentic tasks outside of its core design.

<mark>MetaGPT：MetaGPT通过基于预定义标准操作程序 (SOP) 分配角色和任务来实现多智能体系统。该框架构建智能体协作机制，模拟软件开发公司，智能体扮演产品经理或工程师等角色来完成复杂任务。这种基于SOP的方法能够生成高度结构化且连贯的输出，这对于代码生成等专业领域而言是一项显著优势。该框架的主要局限在于其高度专业化，使其难以适应核心设计之外的通用智能体任务。</mark>

SuperAGI: SuperAGI is an open-source framework designed to provide a complete lifecycle management system for autonomous agents. It includes features for agent provisioning, monitoring, and a graphical interface, aiming to enhance the reliability of agent execution. The key benefit is its focus on production-readiness, with built-in mechanisms to handle common failure modes like looping and to provide observability into agent performance. A potential drawback is that its comprehensive platform approach can introduce more complexity and overhead than a more lightweight, library-based framework.

<mark>SuperAGI：SuperAGI是开源框架，旨在为自主智能体提供完整的生命周期管理系统。它包含智能体配置、监控和图形界面等功能，旨在提高智能体执行的可靠性。其主要优势在于专注于生产就绪性，内置机制可以处理常见的故障模式（例如循环），并提供智能体性能的可观测性。潜在的缺点是，与更轻量级的基于库的框架相比，其全面的平台方法可能会引入更多的复杂性和开销。</mark>

Semantic Kernel: Developed by Microsoft, Semantic Kernel is an SDK that integrates large language models with conventional programming code through a system of "plugins" and "planners." It allows an LLM to invoke native functions and orchestrate workflows, effectively treating the model as a reasoning engine within a larger software application. Its primary strength is its seamless integration with existing enterprise codebases, particularly in .NET and Python environments. The conceptual overhead of its plugin and planner architecture can present a steeper learning curve compared to more straightforward agent frameworks.

<mark>Semantic Kernel：由微软开发的语义内核是软件开发工具包 (SDK)，它通过“插件”和“规划器”系统将大型语言模型与传统编程代码集成。它允许大型语言模型调用原生函数并协调工作流，从而有效地将模型视为大型软件应用程序中的推理引擎。其主要优势在于能够与现有企业代码库无缝集成，尤其是在 .NET 和 Python 环境中。与更直接的智能体框架相比，其插件和规划器架构的概念性开销可能导致更陡峭的学习曲线。</mark>

Strands Agents: An AWS lightweight and flexible SDK that uses a model-driven approach for building and running AI agents. It is designed to be simple and scalable, supporting everything from basic conversational assistants to complex multi-agent autonomous systems. The framework is model-agnostic, offering broad support for various LLM providers, and includes native integration with the MCP for easy access to external tools. Its core advantage is its simplicity and flexibility, with a customizable agent loop that is easy to get started with. A potential trade-off is that its lightweight design means developers may need to build out more of the surrounding operational infrastructure, such as advanced monitoring or lifecycle management systems, which more comprehensive frameworks might provide out-of-the-box.

<mark>Strands Agents：一款轻量级且灵活的 AWS SDK，采用模型驱动方法构建和运行 AI 智能体。它设计简洁且可扩展，支持从基础对话助手到复杂的多智能体自主系统等各种应用。该框架与模型无关，广泛支持各种大语言模型 (LLM) 提供商，并与 MCP 原生集成，方便访问外部工具。其核心优势在于简洁性和灵活性，可自定义的智能体循环易于上手。潜在的不足之处在于，其轻量级设计意味着开发人员可能需要构建更多周边运维基础设施，例如高级监控或生命周期管理系统，而更全面的框架可能提供这些开箱即用的功能。</mark>


## Conclusion | <mark>结语</mark>

The landscape of agentic frameworks offers a diverse spectrum of tools, from low-level libraries for defining agent logic to high-level platforms for orchestrating multi-agent collaboration. At the foundational level, LangChain enables simple, linear workflows, while LangGraph introduces stateful, cyclical graphs for more complex reasoning. Higher-level frameworks like CrewAI and Google's ADK shift the focus to orchestrating teams of agents with predefined roles, while others like LlamaIndex specialize in data-intensive applications. This variety presents developers with a core trade-off between the granular control of graph-based systems and the streamlined development of more opinionated platforms. Consequently, selecting the right framework hinges on whether the application requires a simple sequence, a dynamic reasoning loop, or a managed team of specialists. Ultimately, this evolving ecosystem empowers developers to build increasingly sophisticated AI systems by choosing the precise level of abstraction their project demands.

<mark>智能体框架领域提供了种类繁多的工具，从用于定义智能体逻辑的底层库到用于协调多智能体协作的高级平台，应有尽有。在基础层面，LangChain支持简单的线性工作流，而LangGraph则引入了有状态的循环图，用于更复杂的推理。像CrewAI和Google ADK高级框架则专注于协调具有预定义角色的智能体团队，而像LlamaIndex这样的框架则专注于数据密集型应用。这种多样性给开发者带来了一个核心的权衡：一方面是基于图的系统进行精细控制，另一方面是更规范的平台带来的简化开发体验。因此，选择合适的框架取决于应用程序需要的是简单的序列、动态的推理循环，还是一个由专家组成的团队。最终，这个不断发展的生态系统使开发者能够通过选择项目所需的精确抽象级别，构建日益复杂的AI系统。</mark>

## References | <mark>参考文献</mark>
1. LangChain, https://www.langchain.com/ 
2. LangGraph, https://www.langchain.com/langgraph 
3. Google's ADK, https://google.github.io/adk-docs/ 
4. Crew.AI, https://docs.crewai.com/en/introduction 


