import YAML from "yaml"

import { commitStateFailure, commitStateSuccess } from "./constants"
import { LoggerInterface } from "./logger"
import { Octokit, PR, RuleUserInfo } from "./types"
import { configurationSchema } from "./validation"

const combineUsers = async function (
  pr: PR,
  client: Octokit,
  presetUsers: string[],
  teams: string[],
) {
  const users: Map<string, RuleUserInfo> = new Map()

  for (const user of presetUsers) {
    if (pr.user.login != user) {
      users.set(user, { team: null })
    }
  }

  for (const team of teams) {
    const teamMembersResponse = await client.rest.teams.listMembersInOrg({
      org: pr.base.repo.owner.login,
      team_slug: team,
    })
    if (teamMembersResponse.status !== 200) {
      throw new Error(`Failed to fetch team members from ${team}`)
    }

    for (const member of teamMembersResponse.data) {
      if (member === null) {
        continue
      }
      if (
        pr.user.login != member.login &&
        // We do not want to register a team for this user if their approval is
        // supposed to be requested individually
        users.get(member.login) === undefined
      ) {
        users.set(member.login, { team })
      }
    }
  }

  return users
}

// This function should only depend on its inputs so that it can be tested
// without inconveniences. If you need more external input then pass it as a
// function argument.
export const runChecks = async function (
  pr: PR,
  octokit: Octokit,
  logger: LoggerInterface,
  {
    configFilePath,
    locksReviewTeam,
  }: {
    configFilePath: string
    locksReviewTeam: string
  },
) {
  if (locksReviewTeam.length === 0) {
    logger.failure("Locks Review Team should be provided")
    return commitStateFailure
  }

  const diffResponse: { data: string; status: number } = await octokit.request(
    pr.diff_url,
  )
  if (diffResponse.status !== 200) {
    logger.failure(
      `Failed to get the diff from ${pr.diff_url} (code ${diffResponse.status})`,
    )
    logger.log(diffResponse.data)
    return commitStateFailure
  }
  const { data: diff } = diffResponse

  type MatchedRule = {
    name: string
    min_approvals: number
    users: Map<string, RuleUserInfo>
  }
  const matchedRules: MatchedRule[] = []

  // Built in condition to search files with changes to locked lines
  const lockExpression = /🔒[^\n]*\n[+|-]|(^|\n)[+|-][^\n]*🔒/
  if (lockExpression.test(diff)) {
    logger.log("Diff has changes to 🔒 lines or lines following 🔒")
    const users = await combineUsers(pr, octokit, [], [locksReviewTeam])
    matchedRules.push({ name: "LOCKS TOUCHED", min_approvals: 2, users })
  }

  if (configFilePath === null || configFilePath.length === 0) {
    logger.log("No config file provided")
  } else {
    // Github API does not accept "./*"
    if (configFilePath.startsWith("./")) {
      configFilePath = configFilePath.slice(2)
    }

    const configFileResponse = await octokit.rest.repos.getContent({
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      path: configFilePath,
    })
    if (configFileResponse.status !== 200) {
      logger.failure(
        `Failed to get the contents of ${configFilePath} (code ${configFileResponse.status})`,
      )
      logger.log(configFileResponse.data)
      return commitStateFailure
    }
    const { data } = configFileResponse
    if (typeof data !== "object" || !("content" in data)) {
      logger.failure(
        `Data response for ${configFilePath} had unexpected type (expected object)`,
      )
      logger.log(configFileResponse.data)
      return commitStateFailure
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const configFileContentsEnconded = data.content
    if (typeof configFileContentsEnconded !== "string") {
      logger.failure(
        `Content response for ${configFilePath} had unexpected type (expected string)`,
      )
      logger.log(configFileResponse.data)
      return commitStateFailure
    }

    const configFileContents = Buffer.from(
      configFileContentsEnconded,
      "base64",
    ).toString("utf-8")
    const validationResult = configurationSchema.validate(
      YAML.parse(configFileContents),
    )
    if (validationResult.error) {
      logger.failure("Configuration file is invalid")
      logger.log(validationResult.error)
      return commitStateFailure
    }
    const config = validationResult.value

    // Unlike diff, which is always requested for checking the locks built-in
    // rule, we do not need to load the changed files upfront, only if there's
    // some changed_files rule
    // The actual files will be loaded later in case some rule needs it
    let changedFiles: Set<string> | undefined = undefined

    for (const rule of config.rules) {
      const condition: RegExp = new RegExp(rule.condition, "gm")

      let matched = false
      switch (rule.check_type) {
        case "changed_files": {
          if (changedFiles === undefined) {
            const changedFilesResponse = await octokit.request(
              "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
              {
                owner: pr.base.repo.owner.login,
                repo: pr.base.repo.name,
                pull_number: pr.number,
              },
            )
            if (changedFilesResponse.status !== 200) {
              logger.failure(
                `Failed to get the changed files from ${pr.html_url} (code ${changedFilesResponse.status})`,
              )
              logger.log(changedFilesResponse.data)
              return commitStateFailure
            }
            const { data: changedFilesData } = changedFilesResponse
            changedFiles = new Set(
              changedFilesData.map(({ filename }) => filename),
            )
            logger.log("Changed files", changedFiles)
          }
          changedFilesLoop: for (const file of changedFiles) {
            if (condition.test(file)) {
              logger.log(
                `Matched expression "${rule.condition}" of rule "${rule.name}" for the file ${file}`,
              )
              matched = true
              break changedFilesLoop
            }
          }
          break
        }
        case "diff": {
          if (condition.test(diff)) {
            logger.log(
              `Matched expression "${rule.condition}" of rule "${rule.name}" on diff`,
            )
            matched = true
          }
          break
        }
        default: {
          const exhaustivenessCheck: never = rule.check_type
          logger.failure(`Check type is not handled: ${exhaustivenessCheck}`)
          return commitStateFailure
        }
      }
      if (!matched) {
        continue
      }

      const users = await combineUsers(
        pr,
        octokit,
        rule.users ?? [],
        rule.teams ?? [],
      )

      matchedRules.push({
        name: rule.name,
        min_approvals: rule.min_approvals,
        users,
      })
    }
  }

  if (matchedRules.length !== 0) {
    const reviewsResponse = await octokit.rest.pulls.listReviews({
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      pull_number: pr.number,
    })
    if (reviewsResponse.status !== 200) {
      logger.failure(
        `Failed to fetch reviews from ${pr.html_url} (code ${reviewsResponse.status})`,
      )
      logger.log(reviewsResponse.data)
      return commitStateFailure
    }
    const { data: reviews } = reviewsResponse

    const latestReviews: Map<
      number,
      { id: number; user: string; isApproval: boolean }
    > = new Map()
    for (const review of reviews) {
      if (review.user === null || review.user === undefined) {
        continue
      }
      const prevReview = latestReviews.get(review.user.id)
      if (
        prevReview === undefined ||
        // The latest review is the one with the highest id
        prevReview.id < review.id
      ) {
        latestReviews.set(review.user.id, {
          id: review.id,
          user: review.user.login,
          isApproval: review.state === "APPROVED",
        })
      }
    }
    logger.log("latestReviews", latestReviews.values())

    const problems: string[] = []

    const usersToAskForReview: Map<string, RuleUserInfo> = new Map()
    let highestMinApprovalsRule: MatchedRule | null = null
    for (const rule of matchedRules) {
      if (rule.users.size !== 0) {
        const approvedBy: Set<string> = new Set()
        for (const review of latestReviews.values()) {
          if (rule.users.has(review.user) && review.isApproval) {
            approvedBy.add(review.user)
          }
        }
        if (approvedBy.size < rule.min_approvals) {
          const missingApprovals: {
            username: string
            team: string | null
          }[] = []
          for (const [username, { team }] of rule.users) {
            if (!approvedBy.has(username)) {
              missingApprovals.push({ username, team })
              const prevUser = usersToAskForReview.get(username)
              if (
                // Avoid registering the same user twice
                prevUser === undefined ||
                // If the team is null, this user was not asked as part of a
                // team, but individually. They should always be registered with
                // "team: null" that case to be sure the review will be
                // requested individually, even if they were previously
                // registered as part of a team.
                team === null
              ) {
                usersToAskForReview.set(username, { team })
              }
            }
          }
          problems.push(
            `Rule "${rule.name}" needs at least ${
              rule.min_approvals
            } approvals, but ${
              approvedBy.size
            } were matched. The following users have not approved yet: ${missingApprovals
              .map(function (user) {
                return `${
                  user.username
                }${user.team ? ` (team: ${user.team})` : ""}`
              })
              .join(", ")}.`,
          )
        }
      } else if (
        highestMinApprovalsRule === null ||
        highestMinApprovalsRule.min_approvals < rule.min_approvals
      ) {
        highestMinApprovalsRule = rule
      }
    }

    if (usersToAskForReview.size !== 0) {
      logger.log("usersToAskForReview", usersToAskForReview)
      const teams: Set<string> = new Set()
      const users: Set<string> = new Set()
      for (const [user, { team }] of usersToAskForReview) {
        if (team === null) {
          users.add(user)
        } else {
          teams.add(team)
        }
      }
      await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
        {
          owner: pr.base.repo.owner.login,
          repo: pr.base.repo.name,
          pull_number: pr.number,
          reviewers: Array.from(users),
          team_reviewers: Array.from(teams),
        },
      )
    }

    if (highestMinApprovalsRule !== null) {
      let approvalCount = 0
      for (const review of latestReviews.values()) {
        if (review.isApproval) {
          approvalCount++
        }
      }
      if (approvalCount < highestMinApprovalsRule.min_approvals) {
        problems.push(
          `Rule ${highestMinApprovalsRule.name} requires at least ${highestMinApprovalsRule.min_approvals} approvals, but only ${approvalCount} were given`,
        )
      }
    }

    if (problems.length !== 0) {
      logger.failure("The following problems were found:")
      for (const problem of problems) {
        logger.log(problem)
      }
      logger.log("")
      return commitStateFailure
    }
  }

  return commitStateSuccess
}