import * as h3 from "h3";
import { getBodySerializer } from "../utils";

type BodySerializer = h3._ResponseMiddleware<
  h3.EventHandlerRequest,
  h3.EventHandlerResponse<unknown>
>;

export const bodySerializer: BodySerializer = async (event, { body }) => {
  const { contentType, serializer } = getBodySerializer(
    h3.getHeader(event, "content-type"),
  );
  const bodySerialized = serializer(body);

  if (event.path.startsWith("/reader/")) {
    h3.setHeader(event, "Content-Length", Buffer.byteLength(bodySerialized));
    h3.setHeader(event, "Cache-Control", "no-store");
  }
  await h3.send(event, bodySerialized, contentType);
};
