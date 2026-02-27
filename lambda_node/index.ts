import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

// Declare awslambda global types (available in Lambda runtime)
declare const awslambda: {
  streamifyResponse: (handler: any) => any;
  HttpResponseStream: {
    from: (stream: any, metadata: any) => any;
  };
};

// Initialize Bedrock Agent Core client
const client = new BedrockAgentCoreClient({
  region: process.env.AWS_REGION || "ap-northeast-1"
});

// Agent ARN from environment variable
const AGENT_ARN = process.env.AGENT_ARN || "";

/**
 * Lambda handler with Response Streaming for API Gateway
 * Streams chunks in real-time as they arrive from Agent Core
 */
export const handler = awslambda.streamifyResponse(
  async (event: any, responseStream: any) => {
    // Set response metadata with CORS headers
    const httpResponseMetadata = {
      statusCode: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    };

    // Create the response stream with metadata
    responseStream = awslambda.HttpResponseStream.from(
      responseStream,
      httpResponseMetadata
    );

    try {
      // Parse request body
      const body = JSON.parse(event.body || "{}");

      // Generate session ID (or extract from request if provided)
      // Session ID must be at least 33 characters long
      const sessionId = body.sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2)}-${Math.random().toString(36).substring(2)}`;

      console.log("Calling AgentCore Runtime...");
      console.log("Agent ARN:", AGENT_ARN);
      console.log("Session ID:", sessionId);
      console.log("Request payload:", body);

      // Create the command to invoke the agent
      const command = new InvokeAgentRuntimeCommand({
        agentRuntimeArn: AGENT_ARN,
        runtimeSessionId: sessionId,
        payload: new TextEncoder().encode(JSON.stringify(body)),
        qualifier: "DEFAULT"
      });

      // Invoke the agent
      const response = await client.send(command);

      console.log("Streaming response from AgentCore in real-time...");

      // Stream response directly - no buffering!
      if (response.response) {
        const stream = response.response as Readable;

        // Pipe the stream directly to the response (real-time streaming!)
        await pipeline(stream, responseStream);
      } else {
        responseStream.write('data: {"error": "No response from agent"}\n\n');
      }

    } catch (error) {
      console.error("Error invoking agent:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error("Error details:", errorMessage);

      responseStream.write(`data: {"error": "${errorMessage}"}\n\n`);
    } finally {
      responseStream.end();
    }
  }
);
