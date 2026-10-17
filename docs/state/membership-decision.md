---
id: membership-decision
title: Membership decisions
kind: statechart
status: mixed
summary: Pending members are read from a Next.js route. Approve and reject POST a path the source itself marks as a guess.
parent: skool-mcp
sources:
  - src/tools/members.ts
  - src/client.ts
diagramLinks: {}
diagramDetails:
  - diagram: 0
    node: Reported
    section: Status below 400
  - diagram: 0
    node: Failed
    section: Approve or reject failed
  - diagram: 0
    edge:
      from: Posting
      to: Reported
      label: Status below 400
    section: Status below 400
  - diagram: 0
    edge:
      from: Posting
      to: Failed
      label: Status 400 or higher
    section: Approve or reject failed
---

# Membership decisions

Listing members is a normal Next.js read. Approving or rejecting is not. Those two tools POST to a URL the source comments call the most likely pattern, and they ask the caller to use the raw request tool to find the real one. The local POST is implemented. The claim that Skool exposes those paths is not, so this page is mixed.

The chart is only the approve or reject POST. The pending list is a separate read, described below.

```mermaid
stateDiagram-v2
    [*] --> Posting
    Posting --> Reported: Status below 400
    Posting --> Failed: Status 400 or higher
    Posting --> Failed: The fetch throws
```

## Who can be listed

`skool_members_list` GETs `/{slug}/-/members` through the Next.js helper with `group` and a page number. `skool_members_pending` GETs the same path with `group` and `tab=pending`, and it does not send a page. Both throw when `pageProps` is missing, and both return that object as pretty JSON. The description says pending requires admin or moderator cookies. The code does not check a role. It sends the same cookie string as every other tool.

The slug rule is the same as the other reads: argument, then `defaultCommunity`, then a throw if both are empty.

## Status below 400

Approve POSTs `https://api2.skool.com/groups/{groupId}/members/{memberId}/approve` with no body. Reject POSTs the same shape with `/reject` at the end. Both go through the raw fetch, so a non-ok HTTP status is still a returned result at the fetch layer. The tool then treats a status of 400 or higher as failure. Below 400, the tool returns a sentence that the member was approved or rejected, plus the status and the raw body. It does not parse the body, and it does not check that the body says the decision happened.

The raw fetch still attaches the User-Agent and the cookie string. No extra headers are passed by these two tools, so the cookie is not overridden here. The group id and member id are interpolated into the path with no encoding step in this file.

## Approve or reject failed

A status of 400 or higher throws. The message says approve failed or reject failed, includes the status, and includes up to 500 characters of the body. If the fetch itself throws, that error propagates. The tool has no second URL to try.

A status below 400 is reported as success even when the body is an error page or empty. That cutoff is the only success test in this file.

## Why this is mixed

The list and pending reads are ordinary calls through the shared Next.js helper. Their remote payload shape is unverified, same as the other reads. The approve and reject URLs are a stronger gap: the source comment says the endpoint still needs discovery, and the strings are a guess written into the call. This map did not send those POSTs. Do not treat a 2xx from this chart as proof that Skool changed a membership.
