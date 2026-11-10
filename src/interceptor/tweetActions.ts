import { ClientTransaction, fetchXDocument } from "x-client-transaction-id";
import { buildGraphqlHeaders } from "./headerUtils";
import type { TweetActionRequest } from "@/types/interceptor";

/**
 * `x-client-transaction-id` is required by X for every GraphQL call, but the value has to be
 * minted against the *current* client bundle: the library downloads X's responsive-web shell,
 * reads the `ondemand.s` chunk hash from it and replays the animation key that build uses.
 *
 * Two details matter here:
 *  - the download can fail (network hiccup, rate limit, X serving a different shell), so the
 *    promise must be allowed to retry instead of staying rejected for the whole page session;
 *  - it must be lazy, so one failure at page load cannot silently disable
 *    like/bookmark/retweet/poll/follow before the user ever clicks anything.
 */
let transactionPromise: Promise<ClientTransaction> | null = null;

const getClientTransaction = (): Promise<ClientTransaction> => {
  if (!transactionPromise) {
    transactionPromise = (async () => {
      const xDocument = await fetchXDocument();
      return await ClientTransaction.create(xDocument);
    })().catch((error) => {
      // Drop the cached rejection so the next action retries instead of failing forever.
      transactionPromise = null;
      throw error;
    });
  }
  return transactionPromise;
};

interface GraphqlErrorShape {
  message?: string;
}

/**
 * X answers a rejected mutation with HTTP 200 and an `errors` array. Without this check the
 * content script would treat "not authorized" / "query not found" as success, keep the optimistic
 * state and never roll back.
 */
const assertNoGraphqlErrors = (
  payload: unknown,
  operationName: string
): void => {
  if (!payload || typeof payload !== "object") return;
  const errors = (payload as { errors?: GraphqlErrorShape[] }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return;
  const message = errors
    .map((item) => item?.message)
    .filter((item): item is string => Boolean(item))
    .join("; ");
  throw new Error(
    `${operationName} 被服务端拒绝${message ? `：${message}` : ""}`
  );
};

const readJson = async (response: Response, operationName: string) => {
  const payload = await response.json();
  assertNoGraphqlErrors(payload, operationName);
  return payload;
};

/**
 * Execute a tweet action mutation by replaying the latest GraphQL headers and attaching a freshly
 * generated client transaction id.
 */
export const performTweetActionRequest = async ({
  docId,
  operationName,
  variables,
  features,
  method,
  fieldToggles,
}: TweetActionRequest) => {
  const resolvedMethod = (method ?? "POST").toUpperCase() as "GET" | "POST";
  const path = `/i/api/graphql/${docId}/${operationName}`;
  const url = new URL(path, window.location.origin);
  const headers = buildGraphqlHeaders();

  const transaction = await getClientTransaction();
  const transactionId = await transaction.generateTransactionId(
    resolvedMethod,
    path.replace("/i/api", "")
  );
  headers["x-client-transaction-id"] = transactionId;

  const finalHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    finalHeaders.set(key, value);
  }

  if (resolvedMethod === "GET") {
    url.searchParams.set("variables", JSON.stringify(variables ?? {}));
    if (features && Object.keys(features).length > 0) {
      url.searchParams.set("features", JSON.stringify(features));
    }
    if (fieldToggles && Object.keys(fieldToggles).length > 0) {
      url.searchParams.set("fieldToggles", JSON.stringify(fieldToggles));
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: finalHeaders,
    });

    if (!response.ok) {
      throw new Error(`操作请求失败，状态码 ${response.status}`);
    }

    return readJson(response, operationName);
  }

  const body: Record<string, unknown> = {
    variables,
    queryId: docId,
    queryName: operationName,
    operationName,
  };
  if (features) {
    body.features = features;
  }
  if (fieldToggles) {
    body.fieldToggles = fieldToggles;
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    credentials: "include",
    headers: finalHeaders,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`操作请求失败，状态码 ${response.status}`);
  }

  return readJson(response, operationName);
};
