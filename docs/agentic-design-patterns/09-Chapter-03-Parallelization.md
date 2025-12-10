# Chapter 3: Parallelization | <mark>第三章：并行化</mark>

## Parallelization Pattern Overview | <mark>并行模式概述</mark>

In the previous chapters, we've explored Prompt Chaining for sequential workflows and Routing for dynamic decision-making and transitions between different paths. While these patterns are essential, many complex agentic tasks involve multiple sub-tasks that can be executed *simultaneously* rather than one after another. This is where the **Parallelization** pattern becomes crucial.

<mark>在前面的章节中，我们探讨了用于顺序工作流的提示链以及用于智能决策的路由模式。虽然这些模式很重要，但许多复杂的智能体任务需要<strong>同时</strong>执行多个子任务，而非一个接一个地执行。这时<strong>并行模式</strong>就变得至关重要。</mark>

Parallelization involves executing multiple components, such as LLM calls, tool usages, or even entire sub-agents, concurrently (see Fig.1). Instead of waiting for one step to complete before starting the next, parallel execution allows independent tasks to run at the same time, significantly reducing the overall execution time for tasks that can be broken down into independent parts.

<mark>并行模式涉及同时执行多个组件，例如大语言模型调用、工具使用，甚至整个子智能体（见图 1）。与等待一个步骤完成后再开始下一个步骤不同，并行执行允许独立任务同时运行，这大大缩短了那些可以分解为相互独立部分的任务的总执行时间。</mark>

Consider an agent designed to research a topic and summarize its findings. A sequential approach might:

<mark>考虑实现一个研究主题并汇总结论的智能体。按顺序执行时可能会是这样：</mark>

1. Search for Source A.

   <mark>搜索来源 A。</mark>

2. Summarize Source A.

   <mark>总结来源 A。</mark>

3. Search for Source B.

   <mark>搜索来源 B。</mark>

4. Summarize Source B.

   <mark>总结来源 B。</mark>

5. Synthesize a final answer from summaries A and B.

   <mark>整合总结 A 和 总结 B 中的内容，生成一个最终答案。</mark>

A parallel approach could instead:

<mark>如果使用并行模式则可以优化为：</mark>

1. Search for Source A *and* Search for Source B simultaneously.

   <mark><strong>同时</strong>搜索来源 A 和来源 B。</mark>

2. Once both searches are complete, Summarize Source A *and* Summarize Source B simultaneously.

   <mark>两次搜索完成后，同时对来源 A 和来源 B 进行总结。</mark>

3. Synthesize a final answer from summaries A and B (this step is typically sequential, waiting for the parallel steps to finish).

   <mark>整合总结 A 和 总结 B 中的内容，生成一个最终答案。这一步通常按顺序进行，需要等待前面并行步骤全部完成。</mark>

The core idea is to identify parts of the workflow that do not depend on the output of other parts and execute them in parallel. This is particularly effective when dealing with external services (like APIs or databases) that have latency, as you can issue multiple requests concurrently.

<mark>并行模式的核心在于找出工作流中互不依赖的环节，并将它们并行执行。在处理外部服务（如 API 或数据库）时，这种做法特别有效，因为可以同时发起多个请求，从而减少总体等待时间。</mark>

Implementing parallelization often requires frameworks that support asynchronous execution or multi-threading/multi-processing. Modern agentic frameworks are designed with asynchronous operations in mind, allowing you to easily define steps that can run in parallel.

<mark>实现并行化通常需要使用支持异步执行、多线程或多进程的框架。现代智能体框架原生都能支持异步操作，帮助你方便地定义并同时运行多个步骤。</mark>

![Parallelization Example](/images/chapter03_fig1.png)

Fig.1. Example of parallelization with sub-agents

<mark>图 1：使用子智能体进行并行化的示例</mark>

Frameworks like LangChain, LangGraph, and Google ADK provide mechanisms for parallel execution. In LangChain Expression Language (LCEL), you can achieve parallel execution by combining runnable objects using operators like | (for sequential) and by structuring your chains or graphs to have branches that execute concurrently. LangGraph, with its graph structure, allows you to define multiple nodes that can be executed from a single state transition, effectively enabling parallel branches in the workflow. Google ADK provides robust, native mechanisms to facilitate and manage the parallel execution of agents, significantly enhancing the efficiency and scalability of complex, multi-agent systems. This inherent capability within the ADK framework allows developers to design and implement solutions where multiple agents can operate concurrently, rather than sequentially.

<mark>LangChain、LangGraph 和 Google ADK 等框架都提供了并行执行机制。</mark>

<mark>在 LangChain 表达式语言（LCEL）中，可以使用 <code>|</code> 等运算符组合可运行对象，并通过设计具有并发分支的链或图结构来实现并行执行。而 LangGraph 则利用图结构，允许从状态转换中执行多个节点，从而在工作流中实现并行分支。</mark>

<mark>Google ADK 也提供了强大的原生机制来促进和管理智能体的并行执行，显著提升了复杂多智能体系统的效率和可扩展性。ADK 框架的这一内在能力使开发者能够设计并实现让多个智能体并发运行（而非顺序执行）的解决方案。</mark>

The Parallelization pattern is vital for improving the efficiency and responsiveness of agentic systems, especially when dealing with tasks that involve multiple independent lookups, computations, or interactions with external services. It's a key technique for optimizing the performance of complex agent workflows.

<mark>并行模式对于提升智能体系统的效率和响应速度至关重要，特别是在需要执行多个独立查询、计算或与外部服务交互的场景中。它是优化复杂智能体工作流性能的关键技术。</mark>

---

## Practical Applications & Use Cases | <mark>实际应用场景</mark>

Parallelization is a powerful pattern for optimizing agent performance across various applications:

<mark>并行模式可以在各种场景中使用以提升智能体性能：</mark>

**1. Information Gathering and Research:** | <mark><strong>信息收集和研究：</strong></mark>

Collecting information from multiple sources simultaneously is a classic use case.

<mark>一个经典的用例就是同时从多个来源收集信息。</mark>

- **Use Case:** An agent researching a company.

   <mark><strong>用例：</strong>研究某个公司的智能体。</mark>

- **Parallel Tasks:** Search news articles, pull stock data, check social media mentions, and query a company database, all at the same time.

   <mark><strong>并行执行任务：</strong>同时搜索新闻、拉取股票数据、监测社交媒体上的提及，并查询公司数据库。</mark>
  
- **Benefit:** Gathers a comprehensive view much faster than sequential lookups.

    <mark><strong>好处：</strong>比逐项查找更快获得全面信息。</mark>

**2. Data Processing and Analysis:** | <mark><strong>数据处理和分析：</strong></mark>

Applying different analysis techniques or processing different data segments concurrently.

<mark>使用不同的分析方法或并行处理不同的数据段。</mark>

- **Use Case:** An agent analyzing customer feedback.

   <mark><strong>用例：</strong>分析客户反馈的智能体。</mark>

- **Parallel Tasks:** Run sentiment analysis, extract keywords, categorize feedback, and identify urgent issues simultaneously across a batch of feedback entries.

   <mark><strong>并行处理任务：</strong>在一批反馈中同时进行情感分析、关键词提取、分类，并识别需要优先处理的紧急问题。</mark>

- **Benefit:** Provides a multi-faceted analysis quickly.

   <mark><strong>好处：</strong>快速提供多角度的分析。</mark>

**3. Multi-API or Tool Interaction:** | <mark><strong>多个 API 或工具交互：</strong></mark>

Calling multiple independent APIs or tools to gather different types of information or perform different actions.

<mark>调用多个独立的 API 或工具，以获取不同类别的信息或完成不同的任务。</mark>

- **Use Case:** A travel planning agent.

   <mark><strong>用例：</strong>旅行规划智能体。</mark>

- **Parallel Tasks:** Check flight prices, search for hotel availability, look up local events, and find restaurant recommendations concurrently.

   <mark><strong>并行处理任务：</strong>同时检查航班价格、搜索酒店、了解当地活动，并找到推荐的餐厅。</mark>

- **Benefit:** Presents a complete travel plan faster.

   <mark><strong>好处：</strong>更快速地制定出完整的旅行行程。</mark>

**4. Content Generation with Multiple Components:** | <mark><strong>多组件内容生成：</strong></mark>

Generating different parts of a complex piece of content in parallel.

<mark>并行生成复杂作品的各个部分。</mark>

- **Use Case:** An agent creating a marketing email.

   <mark><strong>用例：</strong>撰写营销邮件的智能体。</mark>

- **Parallel Tasks:** Generate a subject line, draft the email body, find a relevant image, and create a call-to-action button text simultaneously.

   <mark><strong>并行处理任务：</strong>同时生成邮件主题、撰写正文、查找相关图片，并设计具有号召性的按钮文案。</mark>

- **Benefit:** Assembles the final email more efficiently.

   <mark><strong>好处：</strong>更高效地生成电子邮件内容。</mark>

**5. Validation and Verification:** | <mark><strong>验证和核实：</strong></mark>

Performing multiple independent checks or validations concurrently.

<mark>并行执行多个彼此独立的检查或验证。</mark>

- **Use Case:** An agent verifying user input.

   <mark><strong>用例：</strong>验证用户输入的智能体。</mark>

- **Parallel Tasks:** Check email format, validate phone number, verify address against a database, and check for profanity simultaneously.

   <mark><strong>并行执行任务：</strong>同时检查邮件格式、验证电话号码、在数据库中核对地址，并检查是否有不当内容。</mark>

- **Benefit:** Provides faster feedback on input validity.

   <mark><strong>好处：</strong>能够更快地反馈输入是否有效。</mark>

**6. Multi-Modal Processing:** | <mark><strong>多模态处理：</strong></mark>

Processing different modalities (text, image, audio) of the same input concurrently.

<mark>同时对同一输入的不同模态（文本、图像、音频）数据进行处理。</mark>

- **Use Case:** An agent analyzing a social media post with text and an image.

   <mark><strong>用例：</strong>分析包含文本和图像的社交媒体帖子的智能体。</mark>

- **Parallel Tasks:** Analyze the text for sentiment and keywords *and* analyze the image for objects and scene description simultaneously.

   <mark><strong>并行执行任务：</strong>同时分析文本的情感和关键词，以及分析图像中的对象和场景描述。</mark>

- **Benefit:** Integrates insights from different modalities more quickly.

   <mark><strong>好处：</strong>能更快地综合来自不同模态的信息与洞见。</mark>

**7. A/B Testing or Multiple Options Generation:** | <mark><strong>A/B 测试或多种方案生成：</strong></mark>

Generating multiple variations of a response or output in parallel to select the best one.

<mark>并行生成多个响应或输出版本，然后从中挑选最佳的一种。</mark>

- **Use Case:** An agent generating different creative text options.

   <mark><strong>用例：</strong>生成多个创意文案的智能体。</mark>

- **Parallel Tasks:** Generate three different headlines for an article simultaneously using slightly different prompts or models.

   <mark><strong>并行执行任务：</strong>同时使用稍微不同的提示或模型为同一篇文章生成三条各具风格的标题。</mark>

- **Benefit:** Allows for quick comparison and selection of the best option.

   <mark><strong>好处：</strong>可以快速比较各个方案并选出最优者。</mark>

Parallelization is a fundamental optimization technique in agentic design, allowing developers to build more performant and responsive applications by leveraging concurrent execution for independent tasks.

<mark>并行模式是智能体设计中的一项重要优化技术。通过对独立任务进行并发执行，开发者可以构建更高效、更具响应性的应用程序。</mark>

---

## Hands-On Code Example (LangChain) | <mark>实战示例：使用 LangChain</mark>

Parallel execution within the LangChain framework is facilitated by the LangChain Expression Language (LCEL). The primary method involves structuring multiple runnable components within a dictionary or list construct. When this collection is passed as input to a subsequent component in the chain, the LCEL runtime executes the contained runnables concurrently.

<mark>在 LangChain 框架中，通过 LangChain 的表达式语言（LCEL）可以实现并行执行。常见做法是把多个可运行组件组织成字典或列表，并把这个集合作为输入传给链中的下一个组件。LCEL 执行器会并行执行集合中的各个可运行项。</mark>

In the context of LangGraph, this principle is applied to the graph's topology. Parallel workflows are defined by architecting the graph such that multiple nodes, lacking direct sequential dependencies, can be initiated from a single common node. These parallel pathways execute independently before their results can be aggregated at a subsequent convergence point in the graph.

<mark>在 LangGraph 中，这一原则体现在图的拓扑结构上。通过从一个公共节点同时触发多个没有直接顺序依赖的节点，就能形成并行工作流。这些并行路径各自独立运行，之后在图中的某个汇聚点合并结果。</mark>

The following implementation demonstrates a parallel processing workflow constructed with the LangChain framework. This workflow is designed to execute two independent operations concurrently in response to a single user query. These parallel processes are instantiated as distinct chains or functions, and their respective outputs are subsequently aggregated into a unified result.

<mark>以下示例展示了如何使用 LangChain 框架构建并行处理流程：针对同一个用户查询，工作流同时启动两个互不依赖的操作，然后将它们各自的输出合并为一个最终结果。</mark>

The prerequisites for this implementation include the installation of the requisite Python packages, such as langchain, langchain-community, and a model provider library like langchain-openai. Furthermore, a valid API key for the chosen language model must be configured in the local environment for authentication.

<mark>要实现此功能，首先需要安装必要的 Python 包（如 langchain、langchain-community 及 langchain-openai 等模型提供库）。同时需要在本地环境中配置所选语言模型的有效 API 密钥，以便进行身份验证。</mark>

```python
import os
import asyncio
from typing import Optional

from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import Runnable, RunnableParallel, RunnablePassthrough

# Colab 代码链接：https://colab.research.google.com/drive/1uK1r9p-5sdX0ffMjAi_dbIkaMedb1sTj

# 安装依赖
# pip install langchain langchain-community langchain-openai langgraph

# For better security, load environment variables from a .env file
# 为了更好的安全性，建议从 .env 文件加载环境变量
from dotenv import load_dotenv
load_dotenv()

# --- Configuration ---
# Ensure your API key environment variable is set (e.g., OPENAI_API_KEY)
# 确保你的 API 密钥环境变量已设置 (如 OPENAI_API_KEY)
try:
    llm: Optional[ChatOpenAI] = ChatOpenAI(model="gpt-4o-mini", temperature=0.7)
    if llm:
        print(f"Language model initialized: {llm.model_name}")
except Exception as e:
    print(f"Error initializing language model: {e}")
    llm = None


# --- Define Independent Chains ---
# These three chains represent distinct tasks that can be executed in parallel.
# --- 定义独立的链 ---
# 这三条链代表彼此独立、可同时执行的任务。
summarize_chain: Runnable = (
    ChatPromptTemplate.from_messages([
        ("system", "Summarize the following topic concisely:"),
        ("user", "{topic}")
    ])
    | llm
    | StrOutputParser()
)

questions_chain: Runnable = (
    ChatPromptTemplate.from_messages([
        ("system", "Generate three interesting questions about the following topic:"),
        ("user", "{topic}")
    ])
    | llm
    | StrOutputParser()
)

terms_chain: Runnable = (
    ChatPromptTemplate.from_messages([
        ("system", "Identify 5-10 key terms from the following topic, separated by commas:"),
        ("user", "{topic}")
    ])
    | llm
    | StrOutputParser()
)


# --- Build the Parallel + Synthesis Chain ---

# 1. Define the block of tasks to run in parallel. The results of these,
#    along with the original topic, will be fed into the next step.
# --- 定义要并行执行的任务块。这些结果以及原始内容将作为输入传递给下一步。
map_chain = RunnableParallel(
    {
        "summary": summarize_chain,
        "questions": questions_chain,
        "key_terms": terms_chain,
        "topic": RunnablePassthrough(),  # Pass the original topic through
    }
)

# 2. Define the final synthesis prompt which will combine the parallel results.
# --- 定义最终的综合提示，将并行结果合并。
synthesis_prompt = ChatPromptTemplate.from_messages([
    ("system", """Based on the following information:
     Summary: {summary}
     Related Questions: {questions}
     Key Terms: {key_terms}
     Synthesize a comprehensive answer."""),
    ("user", "Original topic: {topic}")
])

# 3. Construct the full chain by piping the parallel results directly
#    into the synthesis prompt, followed by the LLM and output parser.
# --- 通过将并行结果直接传递给综合提示，然后是语言模型和输出解析器，构建完整的链。
full_parallel_chain = map_chain | synthesis_prompt | llm | StrOutputParser()


# --- Run the Chain ---
# --- 运行链 ---
async def run_parallel_example(topic: str) -> None:
    """
    Asynchronously invokes the parallel processing chain with a specific topic
    and prints the synthesized result.

    Args:
        topic: The input topic to be processed by the LangChain chains.
    """
    if not llm:
        print("LLM not initialized. Cannot run example.")
        return

    print(f"\n--- Running Parallel LangChain Example for Topic: '{topic}' ---")
    try:
        # The input to `ainvoke` is the single 'topic' string, which is
        # then passed to each runnable in the `map_chain`.
        # `ainvoke` 的输入是单个 'topic' 字符串，该字符串随后会被传递给 `map_chain` 中的每个可运行项。
        response = await full_parallel_chain.ainvoke(topic)
        print("\n--- Final Response ---")
        print(response)
    except Exception as e:
        print(f"\nAn error occurred during chain execution: {e}")

if __name__ == "__main__":
    test_topic = "The history of space exploration"
    # In Python 3.7+, asyncio.run is the standard way to run an async function.
    # 在 Python 3.7 及更高版本中，asyncio.run 是运行异步函数的标准方式。
    asyncio.run(run_parallel_example(test_topic))
```

译者注：[Colab 代码](https://colab.research.google.com/drive/1uK1r9p-5sdX0ffMjAi_dbIkaMedb1sTj) 已维护在[此处](/codes/Chapter-03-Parallelization-LangChain-Example.py)。

**运行输出（译者添加）：**

```text
Language model initialized: gpt-4o-mini

--- Running Parallel LangChain Example for Topic: 'The history of space exploration' ---

--- Final Response ---
The history of space exploration is a fascinating narrative marked by human curiosity, technological advancement, and international cooperation. It began in the mid-20th century, with the launch of the Soviet satellite Sputnik 1 in 1957, which signified the dawn of the Space Age. This event triggered a series of significant milestones that would shape our understanding of the cosmos.

In 1961, the Soviet space program successfully launched Yuri Gagarin, the first human to journey into space, further igniting the Space Race between the United States and the Soviet Union. This fierce competition led to rapid advancements in technology and culminated with the U.S. Apollo program, which achieved the historic Moon landing in 1969. The success of Apollo 11 not only demonstrated human capability but also inspired generations to look to the stars.

Throughout the 1970s and 1980s, space exploration expanded to include missions to Mars, the launch of revolutionary space telescopes like the Hubble Space Telescope, and the development of the Space Shuttle program. These initiatives allowed for more extended missions and the ability to deploy and service satellites, enhancing our understanding of the universe and our place within it.

The late 1990s saw the launch of the International Space Station (ISS), a landmark achievement in international cooperation in space research. The ISS has become a platform for collaboration among multiple space agencies, including NASA, Roscosmos, ESA, JAXA, and others, allowing scientists from around the world to work together in the unique environment of space.

In recent years, technological advancements, particularly in the realm of reusable rockets, have reshaped the goals and capabilities of space exploration. Companies such as SpaceX and Blue Origin have pioneered private spaceflight initiatives, driving costs down and making space more accessible than ever. This shift has reignited interest in missions targeting Mars, the Moon, and beyond, with plans for crewed missions to Mars on the horizon.

The Space Race has also had lasting effects on international cooperation in contemporary space exploration. The competitive spirit of the Cold War era has evolved into a collaborative approach, exemplified by the ISS and joint missions like the Mars rover endeavors, where multiple countries contribute resources and expertise to achieve common goals.

However, the entrance of private companies into the space exploration sector raises various ethical considerations and potential implications. These include questions about the commercialization of space, the prioritization of profit over scientific research, and concerns about space debris and environmental impacts. As private entities take on larger roles in exploration, the dynamics of scientific research and exploration beyond Earth's atmosphere may shift, necessitating new frameworks for governance and collaboration.

In summary, the history of space exploration is a rich tapestry woven from human ingenuity and cooperation. It reflects our quest to understand the universe, marked by milestones that highlight both our achievements and the challenges that lie ahead. As we move into a new era of exploration, the interplay between public and private initiatives will shape the future of our endeavors among the stars.
```

The provided Python code implements a LangChain application designed for processing a given topic efficiently by leveraging parallel execution. Note that asyncio provides concurrency, not parallelism. It achieves this on a single thread by using an event loop that intelligently switches between tasks when one is idle (e.g., waiting for a network request). This creates the effect of multiple tasks progressing at once, but the code itself is still being executed by only one thread, constrained by Python's Global Interpreter Lock (GIL).

<mark>上述 Python 示例实现了一个基于 LangChain 的应用，通过并发执行来更高效地处理指定话题。需要说明的是，asyncio 实现的是并发（Concurrency），不是多线程或多核的真正并行（Parallelism）。它在单个线程中运行，通过事件循环在任务等待（如等待网络响应）时切换执行，从而让多个任务看起来同时执行。但底层代码仍在同一线程上运行，这是受 Python 全局解释器锁（GIL）的限制。</mark>

The code begins by importing essential modules from langchain_openai and langchain_core, including components for language models, prompts, output parsing, and runnable structures. The code attempts to initialize a ChatOpenAI instance, specifically using the "gpt-4o-mini" model, with a specified temperature for controlling creativity. A try-except block is used for robustness during the language model initialization. Three independent LangChain "chains" are then defined, each designed to perform a distinct task on the input topic. The first chain is for summarizing the topic concisely, using a system message and a user message containing the topic placeholder. The second chain is configured to generate three interesting questions related to the topic. The third chain is set up to identify between 5 and 10 key terms from the input topic, requesting them to be comma-separated. Each of these independent chains consists of a ChatPromptTemplate tailored to its specific task, followed by the initialized language model and a StrOutputParser to format the output as a string.

<mark>代码从 <code>langchain_openai</code> 和 <code>langchain_core</code> 导入了关键模块，包含语言模型、提示模板、输出解析器和可运行组件。接着尝试初始化一个 <code>ChatOpenAI</code> 实例，指定使用 <code>gpt-4o-mini</code> 模型，并设置了控制创造力的温度值，初始化时用 <code>try-except</code> 来保证健壮性。随后定义了三条相互独立的 LangChain 链，每条链负责对输入主题执行不同任务：第一条链用来简洁地总结主题，采用系统消息和包含主题占位符的用户消息；第二条链生成与主题相关的三个有趣问题；第三条链则从主题中识别 5 到 10 个关键术语，要求用逗号分隔。每条链都由为该任务定制的 <code>ChatPromptTemplate</code>、已初始化的语言模型和用于把输出格式化为字符串的 <code>StrOutputParser</code> 组成。</mark>

A RunnableParallel block is then constructed to bundle these three chains, allowing them to execute simultaneously. This parallel runnable also includes a RunnablePassthrough to ensure the original input topic is available for subsequent steps. A separate ChatPromptTemplate is defined for the final synthesis step, taking the summary, questions, key terms, and the original topic as input to generate a comprehensive answer. The full end-to-end processing chain, named full_parallel_chain, is created by sequencing the map_chain (the parallel block) into the synthesis prompt, followed by the language model and the output parser. An asynchronous function run_parallel_example is provided to demonstrate how to invoke this full_parallel_chain. This function takes the topic as input and uses invoke to run the asynchronous chain. Finally, the standard Python if __name__ == "__main__": block shows how to execute the run_parallel_example with a sample topic, in this case, "The history of space exploration", using asyncio.run to manage the asynchronous execution.

<mark>随后构建了一个 <code>RunnableParallel</code> 块，把这三条链打包在一起以便同时运行。这个运行单元还包含一个 <code>RunnablePassthrough</code>，确保原始输入的主题可以在后续步骤中使用。</mark>

<mark>接着为最后的汇总步骤定义了一个独立的 <code>ChatPromptTemplate</code>，使用摘要、问题、关键术语和原始主题作为输入来生成完整的答案。这个名为 <code>full_parallel_chain</code> 的端到端处理链，是通过 <code>map_chain</code> 连接到汇总提示，再接语言模型和输出解析器来构建的。</mark>

<mark>示例中提供了一个异步函数 <code>run_parallel_example</code>，用来演示如何调用这个 <code>full_parallel_chain</code>，该函数接收主题作为输入并通过 <code>invoke</code> 运行异步链。</mark>

<mark>最后，通过标准的 Python <code>if __name__ == "__main__":</code> 代码块演示如何用 <code>asyncio.run</code> 管理异步执行，来启动 <code>run_parallel_example</code> 方法，其中主题为「航天探索史」。</mark>

In essence, this code sets up a workflow where multiple LLM calls (for summarizing, questions, and terms) happen at the same time for a given topic, and their results are then combined by a final LLM call. This showcases the core idea of parallelization in an agentic workflow using LangChain.

<mark>本质上，这段代码构建了一个工作流：针对某个主题，使用大语言模型同时进行摘要、提问和术语等多个调用，随后由一次最终的请求把这些输出整合在一起。该示例说明了在使用 LangChain 的智能体工作流中通过并行执行来提高效率的核心思想。</mark>

---

## Hands-On Code Example (Google ADK) | <mark>实战示例：使用 Google ADK</mark>

Okay, let's now turn our attention to a concrete example illustrating these concepts within the Google ADK framework. We'll examine how the ADK primitives, such as ParallelAgent and SequentialAgent, can be applied to build an agent flow that leverages concurrent execution for improved efficiency.

<mark>现在通过 Google ADK 框架中的具体示例来说明这些概念。我们将展示 ADK 的基本组件（如 ParallelAgent 和 SequentialAgent）来构建智能体流程，从而通过并行执行提高效率。</mark>

```python
# Part of agent.py --> Follow https://google.github.io/adk-docs/get-started/quickstart/ to learn the setup
# --- 1. Define Researcher Sub-Agents (to run in parallel) ---
# --- 定义研究员子智能体（并行执行） ---

 # Researcher 1: Renewable Energy
 # 研究员 1：可再生能源
 researcher_agent_1 = LlmAgent(
     name="RenewableEnergyResearcher",
     model=GEMINI_MODEL,
     instruction="""You are an AI Research Assistant specializing in energy.
 Research the latest advancements in 'renewable energy sources'.
 Use the Google Search tool provided.
 Summarize your key findings concisely (1-2 sentences).
 Output *only* the summary.
 """,
     description="Researches renewable energy sources.",
     tools=[google_search],
     # Store result in state for the merger agent
     output_key="renewable_energy_result"
 )

 # Researcher 2: Electric Vehicles
 # 研究员 2：电动汽车
 researcher_agent_2 = LlmAgent(
     name="EVResearcher",
     model=GEMINI_MODEL,
     instruction="""You are an AI Research Assistant specializing in transportation.
 Research the latest developments in 'electric vehicle technology'.
 Use the Google Search tool provided.
 Summarize your key findings concisely (1-2 sentences).
 Output *only* the summary.
 """,
     description="Researches electric vehicle technology.",
     tools=[google_search],
     # Store result in state for the merger agent
     output_key="ev_technology_result"
 )

 # Researcher 3: Carbon Capture
 # 研究员 3：碳捕获
 researcher_agent_3 = LlmAgent(
     name="CarbonCaptureResearcher",
     model=GEMINI_MODEL,
     instruction="""You are an AI Research Assistant specializing in climate solutions.
 Research the current state of 'carbon capture methods'.
 Use the Google Search tool provided.
 Summarize your key findings concisely (1-2 sentences).
 Output *only* the summary.
 """,
     description="Researches carbon capture methods.",
     tools=[google_search],
     # Store result in state for the merger agent
     output_key="carbon_capture_result"
 )

 # --- 2. Create the ParallelAgent (Runs researchers concurrently) ---
 # This agent orchestrates the concurrent execution of the researchers.
 # It finishes once all researchers have completed and stored their results in state.
 # --- 2. 创建 ParallelAgent（并行运行多个研究员子智能体） ---
 # 该智能体协调多个研究员子智能体的并发执行。
 # 所有研究员完成工作并将结果写入状态后，流程即结束。
 parallel_research_agent = ParallelAgent(
     name="ParallelWebResearchAgent",
     sub_agents=[researcher_agent_1, researcher_agent_2, researcher_agent_3],
     description="Runs multiple research agents in parallel to gather information."
 )

 # --- 3. Define the Merger Agent (Runs *after* the parallel agents) ---
 # This agent takes the results stored in the session state by the parallel agents
 # and synthesizes them into a single, structured response with attributions.
 # --- 3. 定义合并智能体（在并行研究员子智能体之后运行） ---
 # 该智能体使用并行运行的子智能体已保存在会话状态中的结果，
 # 将这些内容整合并归纳为一份结构化的响应，并在相应部分标注出处。
 merger_agent = LlmAgent(
     name="SynthesisAgent",
     model=GEMINI_MODEL,  # Or potentially a more powerful model if needed for synthesis
     instruction="""You are an AI Assistant responsible for combining research findings into a structured report.

 Your primary task is to synthesize the following research summaries, clearly attributing findings to their source areas. Structure your response using headings for each topic. Ensure the report is coherent and integrates the key points smoothly.

 **Crucially: Your entire response MUST be grounded *exclusively* on the information provided in the 'Input Summaries' below. Do NOT add any external knowledge, facts, or details not present in these specific summaries.**

 **Input Summaries:**

 *   **Renewable Energy:**
     {renewable_energy_result}

 *   **Electric Vehicles:**
     {ev_technology_result}

 *   **Carbon Capture:**
     {carbon_capture_result}

 **Output Format:**

 ## Summary of Recent Sustainable Technology Advancements

 ### Renewable Energy Findings
 (Based on RenewableEnergyResearcher's findings)
 [Synthesize and elaborate *only* on the renewable energy input summary provided above.]

 ### Electric Vehicle Findings
 (Based on EVResearcher's findings)
 [Synthesize and elaborate *only* on the EV input summary provided above.]

 ### Carbon Capture Findings
 (Based on CarbonCaptureResearcher's findings)
 [Synthesize and elaborate *only* on the carbon capture input summary provided above.]

 ### Overall Conclusion
 [Provide a brief (1-2 sentence) concluding statement that connects *only* the findings presented above.]

 Output *only* the structured report following this format. Do not include introductory or concluding phrases outside this structure, and strictly adhere to using only the provided input summary content.
 """,
     description="Combines research findings from parallel agents into a structured, cited report, strictly grounded on provided inputs.",
     # No tools needed for merging
     # No output_key needed here, as its direct response is the final output of the sequence
 )


 # --- 4. Create the SequentialAgent (Orchestrates the overall flow) ---
 # This is the main agent that will be run. It first executes the ParallelAgent
 # to populate the state, and then executes the MergerAgent to produce the final output.
 # --- 4. 创建 SequentialAgent（协调整个流程） ---
 # 这是将被运行的主智能体。它先执行 ParallelAgent 来填充状态，
 # 然后执行 MergerAgent 来生成最终输出。
 sequential_pipeline_agent = SequentialAgent(
     name="ResearchAndSynthesisPipeline",
     # Run parallel research first, then merge
     sub_agents=[parallel_research_agent, merger_agent],
     description="Coordinates parallel research and synthesizes the results."
 )

 root_agent = sequential_pipeline_agent
```

译者注：[Colab 代码](https://colab.research.google.com/drive/1gcztL9ebeqGeWl-_0E9FeMcHMOsknB0I) 已维护在[此处](/codes/Chapter-03-Parallelization-ADK-Example.py)。

This code defines a multi-agent system used to research and synthesize information on sustainable technology advancements. It sets up three LlmAgent instances to act as specialized researchers. ResearcherAgent_1 focuses on renewable energy sources, ResearcherAgent_2 researches electric vehicle technology, and ResearcherAgent_3 investigates carbon capture methods. Each researcher agent is configured to use a GEMINI_MODEL and the google_search tool. They are instructed to summarize their findings concisely (1-2 sentences) and store these summaries in the session state using output_key.

<mark>该代码建立了一个多智能体系统，用于收集与整合可持续技术进展的资料。系统包含三个子智能体担任不同的研究员：<code>ResearcherAgent_1</code> 聚焦可再生能源，<code>ResearcherAgent_2</code> 研究电动汽车技术，<code>ResearcherAgent_3</code> 调查碳捕集技术。每个研究员子智能体都配置为使用 <code>GEMINI_MODEL</code> 和 <code>google_search</code> 工具，并要求使用一到两句话总结研究结果，随后通过 <code>output_key</code> 将这些总结内容保存到会话状态中。</mark>

A ParallelAgent named ParallelWebResearchAgent is then created to run these three researcher agents concurrently. This allows the research to be conducted in parallel, potentially saving time. The ParallelAgent completes its execution once all its sub-agents (the researchers) have finished and populated the state.

<mark>然后创建了一个名为 <code>ParallelWebResearchAgent</code> 的并行智能体，用于同时运行这三个研究员子智能体。这样可以并行开展研究，节省时间。只有当所有子智能体（研究员）都完成并将结果写入状态后，并行智能体才算执行结束。</mark>

Next, a MergerAgent (also an LlmAgent) is defined to synthesize the research results. This agent takes the summaries stored in the session state by the parallel researchers as input. Its instruction emphasizes that the output must be strictly based only on the provided input summaries, prohibiting the addition of external knowledge. The MergerAgent is designed to structure the combined findings into a report with headings for each topic and a brief overall conclusion.

<mark>接下来，定义了一个 <code>MergerAgent</code>（也是 <code>LlmAgent</code>）来综合研究结果。该智能体将并行研究员子智能体存储在会话状态中的总结内容作为输入。其指令强调输出必须严格基于所提供的总结内容，禁止添加外部知识。<code>MergerAgent</code> 旨在将合并的发现结构化为报告，每个主题都有标题和简要的结论。</mark>

Finally, a SequentialAgent named ResearchAndSynthesisPipeline is created to orchestrate the entire workflow. As the primary controller, this main agent first executes the ParallelAgent to perform the research. Once the ParallelAgent is complete, the SequentialAgent then executes the MergerAgent to synthesize the collected information. The sequential_pipeline_agent is set as the root_agent, representing the entry point for running this multi-agent system. The overall process is designed to efficiently gather information from multiple sources in parallel and then combine it into a single, structured report.

<mark>最后，创建了一个名为 <code>ResearchAndSynthesisPipeline</code> 的顺序型智能体来协调整个工作流。作为主要控制器，该主智能体首先执行 <code>ParallelAgent</code> 来进行研究。<code>ParallelAgent</code> 完成后，<code>SequentialAgent</code> 会执行 <code>MergerAgent</code> 来综合收集的信息。<code>sequential_pipeline_agent</code> 被设置为 <code>root_agent</code>，代表运行该多智能体系统的入口。整个流程的设计目标是并行从多个来源高效收集信息，然后将这些信息合并为一份结构化报告。</mark>

---

## At a Glance | <mark>要点速览</mark>

**What:** Many agentic workflows involve multiple sub-tasks that must be completed to achieve a final goal. A purely sequential execution, where each task waits for the previous one to finish, is often inefficient and slow. This latency becomes a significant bottleneck when tasks depend on external I/O operations, such as calling different APIs or querying multiple databases. Without a mechanism for concurrent execution, the total processing time is the sum of all individual task durations, hindering the system's overall performance and responsiveness.

<mark><strong>问题所在：</strong>许多智能体工作流涉及多个必须完成的子任务以实现最终目标。纯粹的顺序执行，即每个任务等待前一个任务完成再执行，通常效率低下且速度缓慢。当任务依赖于外部 I/O 操作（如调用不同的 API 或查询多个数据库）时，这种延迟会成为重大瓶颈。没有并发机制时，总耗时就是各个任务耗时的累加，进而影响系统的性能和响应速度。</mark>

**Why:** The Parallelization pattern provides a standardized solution by enabling the simultaneous execution of independent tasks. It works by identifying components of a workflow, like tool usages or LLM calls, that do not rely on each other's immediate outputs. Agentic frameworks like LangChain and the Google ADK provide built-in constructs to define and manage these concurrent operations. For instance, a main process can invoke several sub-tasks that run in parallel and wait for all of them to complete before proceeding to the next step. By running these independent tasks at the same time rather than one after another, this pattern drastically reduces the total execution time.

<mark><strong>解决之道：</strong>并行模式通过同时执行彼此独立的任务，提供了一种标准化的解决方案来缩短整体执行时间。它的做法是识别工作流中不相互依赖的部分，比如某些工具调用或大语言模型请求。像 LangChain 和 Google ADK 这样的智能体框架内置了用于定义和管理并发操作的能力。举例来说，主流程可以启动多个并行的子任务，然后在继续下一步之前等待这些子任务全部完成。相比与顺序执行，这种并行执行能大幅减少总耗时。</mark>

**Rule of thumb:** Use this pattern when a workflow contains multiple independent operations that can run simultaneously, such as fetching data from several APIs, processing different chunks of data, or generating multiple pieces of content for later synthesis.

<mark><strong>经验法则：</strong>当工作流中存在多个相互独立且可并行执行的任务时应采用该模式，例如同时从多个 API 拉取数据、并行处理不同的数据分片，或同时生成多个将来需要合并的内容，从而缩短总体执行时间。</mark>

**Visual summary** | <mark><strong>可视化总结</strong></mark>

![Parallelization Pattern](/images/chapter03_fig2.jpg)

Fig.2: Parallelization design pattern

<mark>图 2：并行化设计模式</mark>

---

## Key Takeaways | <mark>核心要点</mark>

Here are the key takeaways:

<mark>以下是关键要点：</mark>

- Parallelization is a pattern for executing independent tasks concurrently to improve efficiency.

   <mark>并行模式是一种将相互独立的任务同时执行，从而缩短总耗时并提高效率的方法。</mark>

- It is particularly useful when tasks involve waiting for external resources, such as API calls.

   <mark>在任务需要等待外部资源（比如调用 API）时，这种方式特别有用。</mark>

- The adoption of a concurrent or parallel architecture introduces substantial complexity and cost, impacting key development phases such as design, debugging, and system logging.

   <mark>采用并发或并行架构会显著增加复杂性和成本，从而对设计、调试和日志等开发环节带来影响。</mark>

- Frameworks like LangChain and Google ADK provide built-in support for defining and managing parallel execution.

   <mark>像 LangChain 和 Google ADK 这样的框架内置了对并行执行的支持，方便定义和管理并行任务。</mark>

- In LangChain Expression Language (LCEL), RunnableParallel is a key construct for running multiple runnables side-by-side.

   <mark>在 LangChain 的表达式语言（LCEL）中，RunnableParallel 是一个核心组件，用于并行执行多个可运行单元。</mark>

- Google ADK can facilitate parallel execution through LLM-Driven Delegation, where a Coordinator agent's LLM identifies independent sub-tasks and triggers their concurrent handling by specialized sub-agents.

   <mark>Google ADK 可以通过大语言模型驱动的委派机制来实现并行执行，其中协调器智能体中的大语言模型会识别出互相独立的子任务，并将这些任务分派给相应的子智能体去处理，从而并发完成各个子任务。</mark>

- Parallelization helps reduce overall latency and makes agentic systems more responsive for complex tasks.

   <mark>并行模式能有效减少总体耗时，从而提升智能体系统对复杂任务的响应能力。</mark>

---

## Conclusion | <mark>结语</mark>

The parallelization pattern is a method for optimizing computational workflows by concurrently executing independent sub-tasks. This approach reduces overall latency, particularly in complex operations that involve multiple model inferences or calls to external services.

<mark>并行模式是通过并发执行独立子任务来优化计算流程。对于需要多次模型推理或调用外部服务的复杂操作，采用并行执行可以显著降低总体耗时并提高效率。</mark>

Frameworks provide distinct mechanisms for implementing this pattern. In LangChain, constructs like RunnableParallel are used to explicitly define and execute multiple processing chains simultaneously. In contrast, frameworks like the Google Agent Developer Kit (ADK) can achieve parallelization through multi-agent delegation, where a primary coordinator model assigns different sub-tasks to specialized agents that can operate concurrently.

<mark>不同的框架为实现此模式提供了不同的机制。在 LangChain 中，像 RunnableParallel 这样的组件可以用于显式定义和执行多个处理链。相比之下，Google ADK 可以通过多智能体委派机制实现并行化，其中主协调器模型将不同的子任务分配给可以并发执行的专用智能体。</mark>

By integrating parallel processing with sequential (chaining) and conditional (routing) control flows, it becomes possible to construct sophisticated, high-performance computational systems capable of efficiently managing diverse and complex tasks.

<mark>将并行处理与顺序（链式）和条件（路由）控制流结合起来，可以构建既复杂又高效的计算系统，从而更有效地管理各类复杂任务。</mark>

---

## References | <mark>参考文献</mark>

Here are some resources for further reading on the Parallelization pattern and related concepts:

<mark>以下是一些可供深入了解并行模式及其相关概念的推荐阅读资料：</mark>

1. LangChain Expression Language (LCEL) Documentation (Parallelism): [https://python.langchain.com/docs/concepts/lcel/](https://python.langchain.com/docs/concepts/lcel/)

   <mark>LangChain 表达式语言文档（并行化）：[https://python.langchain.com/docs/concepts/lcel/](https://python.langchain.com/docs/concepts/lcel/)</mark>

2. Google Agent Developer Kit (ADK) Documentation (Multi-Agent Systems): [https://google.github.io/adk-docs/agents/multi-agents/](https://google.github.io/adk-docs/agents/multi-agents/)

   <mark>Google ADK 文档（多智能体系统）：[https://google.github.io/adk-docs/agents/multi-agents/](https://google.github.io/adk-docs/agents/multi-agents/)</mark>

3. Python asyncio Documentation: [https://docs.python.org/3/library/asyncio.html](https://docs.python.org/3/library/asyncio.html)

   <mark>Python asyncio 文档：[https://docs.python.org/3/library/asyncio.html](https://docs.python.org/3/library/asyncio.html)</mark>
