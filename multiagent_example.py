"""
Simple Multi-Agent Example with Strands Framework and Memory
This demonstrates multiple specialized agents working together with conversation memory
"""

import os
import boto3
from strands import Agent
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from starlette.middleware.cors import CORSMiddleware
from starlette.staticfiles import StaticFiles
from starlette.responses import FileResponse

# Initialize Memory Client via boto3
memory_client = boto3.client('bedrock-agentcore', region_name=os.getenv("AWS_REGION", "ap-northeast-1"))
MEMORY_ID = os.getenv("MEMORY_ID")  # Will be set during deployment

# Create specialized agents following Chain-of-Thought pattern
# Using Japan (apac) cross-region inference profile

planner_agent = Agent(
    name="Planner",
    model="apac.anthropic.claude-3-5-sonnet-20241022-v2:0",
    system_prompt="""You are a strategic planner agent with access to conversation history. Your role is to:
    1. Consider previous conversations and context when planning
    2. Break down complex queries into manageable sub-tasks
    3. Identify what information is needed
    4. Create a step-by-step plan to answer the query
    5. Determine the approach and methodology
    Output a clear, structured plan."""
)

retriever_agent = Agent(
    name="Retriever",
    model="apac.anthropic.claude-3-5-sonnet-20241022-v2:0",
    system_prompt="""You are a knowledge retriever agent. Your role is to:
    1. Based on the plan, gather relevant information
    2. Research and collect key facts, data, and context
    3. Organize information in a structured way
    4. Ensure completeness and accuracy
    Output comprehensive, well-organized information."""
)

analyzer_agent = Agent(
    name="Analyzer",
    model="apac.anthropic.claude-3-5-sonnet-20241022-v2:0",
    system_prompt="""You are an analytical agent with memory of past conversations. Your role is to:
    1. Consider conversation history and previous context
    2. Process and analyze information with awareness of past interactions
    3. Apply critical thinking and reasoning
    4. Synthesize insights and conclusions that build on previous discussions
    5. Generate a comprehensive response
    Output clear, well-reasoned analysis and answers."""
)

validator_agent = Agent(
    name="Validator",
    model="apac.anthropic.claude-3-5-sonnet-20241022-v2:0",
    system_prompt="""You are a validation agent. Your role is to:
    1. Review the analysis for accuracy and completeness
    2. Check for logical consistency and errors
    3. Verify the response addresses the original query
    4. Suggest improvements or confirm quality
    Output validation results and final recommendations."""
)

# Create the app
app = BedrockAgentCoreApp()

# Enable CORS for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins in development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Serve frontend at root
@app.route("/")
async def homepage(request):
    return FileResponse("static/index.html")


def get_memory_context(actor_id: str, user_message: str) -> str:
    """Retrieve relevant memory context for the conversation"""
    if not MEMORY_ID:
        return ""

    try:
        # Retrieve memory records related to the current query
        response = memory_client.retrieve_memory_records(
            memoryId=MEMORY_ID,
            namespace=f"agent/knowledge/{actor_id}",
            searchCriteria={
                'searchQuery': user_message
            },
            maxResults=5
        )

        if 'memoryRecords' in response and response['memoryRecords']:
            context_parts = []
            for record in response['memoryRecords']:
                content = record.get('content', {})
                if isinstance(content, dict):
                    text = content.get('text', '')
                else:
                    text = str(content)
                if text:
                    context_parts.append(f"- {text}")

            if context_parts:
                return f"\n\n**Relevant context from previous conversations:**\n" + "\n".join(context_parts)
        return ""
    except Exception as e:
        print(f"Error retrieving memories: {e}")
        return ""


def save_conversation(actor_id: str, session_id: str, user_message: str, assistant_response: str):
    """Save conversation to memory"""
    if not MEMORY_ID:
        return

    try:
        import datetime
        # Create event to save conversation to memory
        # Payload is a list where each item represents a conversational turn
        payload = [
            {'conversational': {'role': 'USER', 'content': {'text': user_message}}},
            {'conversational': {'role': 'ASSISTANT', 'content': {'text': assistant_response}}}
        ]

        memory_client.create_event(
            memoryId=MEMORY_ID,
            actorId=actor_id,
            sessionId=session_id,
            eventTimestamp=datetime.datetime.now(datetime.timezone.utc),
            payload=payload
        )
        print(f"✓ Conversation saved to memory for actor: {actor_id}")
    except Exception as e:
        print(f"Error saving to memory: {e}")


@app.entrypoint
async def invoke(payload):
    """Chain-of-Thought Multi-Agent Workflow with Memory Support"""
    user_message = payload.get("prompt", "Hello")
    workflow_type = payload.get("workflow", "chain-of-thought")

    # Extract actor_id and session_id from payload
    session_id = payload.get("sessionId", "default-session")
    actor_id = payload.get("actorId", "default-user")  # Frontend can send user ID

    # Retrieve memory context before processing
    memory_context = get_memory_context(actor_id, user_message)

    # Add memory context to user message if available
    enhanced_message = user_message
    if memory_context:
        enhanced_message = f"{user_message}\n{memory_context}"

    # Variable to store complete assistant response
    complete_response = ""

    if workflow_type == "chain-of-thought":
        # Phase 1: Planning
        yield {"phase": "planning", "status": "starting", "agent": "Planner"}

        plan_text = ""
        async for event in planner_agent.stream_async(f"Create a plan to answer: {enhanced_message}"):
            if isinstance(event, dict) and 'data' in event:
                chunk = event['data']
                plan_text += chunk
                yield {
                    "phase": "planning",
                    "status": "streaming",
                    "agent": "Planner",
                    "chunk": chunk
                }

        yield {"phase": "planning", "status": "complete", "agent": "Planner"}

        # Phase 2: Retrieval
        yield {"phase": "retrieval", "status": "starting", "agent": "Retriever"}

        retrieval_text = ""
        async for event in retriever_agent.stream_async(
            f"Based on this plan, retrieve relevant information:\n\nPlan: {plan_text}\n\nOriginal Query: {user_message}"
        ):
            if isinstance(event, dict) and 'data' in event:
                chunk = event['data']
                retrieval_text += chunk
                yield {
                    "phase": "retrieval",
                    "status": "streaming",
                    "agent": "Retriever",
                    "chunk": chunk
                }

        yield {"phase": "retrieval", "status": "complete", "agent": "Retriever"}

        # Phase 3: Analysis
        yield {"phase": "analysis", "status": "starting", "agent": "Analyzer"}

        analysis_text = ""
        async for event in analyzer_agent.stream_async(
            f"Analyze this information and provide a comprehensive answer:\n\nRetrieved Information: {retrieval_text}\n\nOriginal Query: {user_message}"
        ):
            if isinstance(event, dict) and 'data' in event:
                chunk = event['data']
                analysis_text += chunk
                yield {
                    "phase": "analysis",
                    "status": "streaming",
                    "agent": "Analyzer",
                    "chunk": chunk
                }

        yield {"phase": "analysis", "status": "complete", "agent": "Analyzer"}

        # Phase 4: Validation
        yield {"phase": "validation", "status": "starting", "agent": "Validator"}

        validation_text = ""
        async for event in validator_agent.stream_async(
            f"Validate this analysis and provide final recommendations:\n\nAnalysis: {analysis_text}\n\nOriginal Query: {user_message}"
        ):
            if isinstance(event, dict) and 'data' in event:
                chunk = event['data']
                validation_text += chunk
                yield {
                    "phase": "validation",
                    "status": "streaming",
                    "agent": "Validator",
                    "chunk": chunk
                }

        yield {"phase": "validation", "status": "complete", "agent": "Validator"}

        # Phase 5: Generate Final Answer for User
        yield {"phase": "final", "status": "starting", "agent": "Final Answer"}

        final_answer = f"""Based on the comprehensive analysis:

{analysis_text}

---
*This answer was generated using a chain-of-thought approach with multiple AI agents working together.*
"""
        complete_response = final_answer

        # Send final answer in chunks
        for i in range(0, len(final_answer), 50):
            chunk = final_answer[i:i+50]
            yield {
                "phase": "final",
                "status": "streaming",
                "agent": "Final Answer",
                "chunk": chunk
            }

        yield {"phase": "final", "status": "complete", "agent": "Final Answer"}
        yield {"phase": "done", "status": "complete"}

    elif workflow_type == "quick":
        # Quick analysis - just Analyzer
        yield {"phase": "analysis", "status": "starting", "agent": "Analyzer"}

        async for event in analyzer_agent.stream_async(enhanced_message):
            if isinstance(event, dict) and 'data' in event:
                chunk = event['data']
                complete_response += chunk
                yield {
                    "phase": "analysis",
                    "status": "streaming",
                    "agent": "Analyzer",
                    "chunk": chunk
                }

        yield {"phase": "analysis", "status": "complete", "agent": "Analyzer"}
        yield {"phase": "done", "status": "complete"}

    elif workflow_type == "quick-response":
        # Quick response - streams directly as final answer for nice display
        yield {"phase": "final", "status": "starting", "agent": "Quick Response"}

        async for event in analyzer_agent.stream_async(enhanced_message):
            if isinstance(event, dict) and 'data' in event:
                chunk = event['data']
                complete_response += chunk
                yield {
                    "phase": "final",
                    "status": "streaming",
                    "agent": "Quick Response",
                    "chunk": chunk
                }

        yield {"phase": "final", "status": "complete", "agent": "Quick Response"}
        yield {"phase": "done", "status": "complete"}

    else:  # simple
        # Simple response - just Planner for quick planning
        yield {"phase": "planning", "status": "starting", "agent": "Planner"}

        async for event in planner_agent.stream_async(enhanced_message):
            if isinstance(event, dict) and 'data' in event:
                chunk = event['data']
                complete_response += chunk
                yield {
                    "phase": "planning",
                    "status": "streaming",
                    "agent": "Planner",
                    "chunk": chunk
                }

        yield {"phase": "planning", "status": "complete", "agent": "Planner"}
        yield {"phase": "done", "status": "complete"}

    # Save conversation to memory after completing response
    if complete_response:
        save_conversation(actor_id, session_id, user_message, complete_response)


if __name__ == "__main__":
    import os

    # Use PORT from environment (for Bedrock Agent Core deployment) or default to 8090 for local dev
    port = int(os.getenv("PORT", "8090"))

    print("🤖 Multi-Agent Chain-of-Thought Server with Memory Starting...")
    print(f"📍 Server: http://0.0.0.0:{port}")
    print(f"🌐 Web UI: http://localhost:{port}")
    print(f"🧠 Memory: {'Enabled' if MEMORY_ID else 'Disabled (set MEMORY_ID env var)'}")
    print("\n🧠 Available Workflows (UI):")
    print("   1. Chain-of-Thought: Planner → Retriever → Analyzer → Validator (thorough)")
    print("   2. Quick Response: Just Analyzer (fast, beautiful display)")
    print("\n📝 API-Only Workflows:")
    print("   - quick: Just Analyzer (collapsible display)")
    print("   - simple: Just Planner (for planning)")
    print("\n📝 API Usage:")
    print(f'   curl -X POST http://localhost:{port}/invocations \\')
    print('        -H "Content-Type: application/json" \\')
    print('        -d \'{"prompt": "Explain quantum computing", "workflow": "quick-response", "actorId": "user123"}\'')
    print("\n✨ Starting server with streaming and memory...\n")

    app.run(host="0.0.0.0", port=port)
