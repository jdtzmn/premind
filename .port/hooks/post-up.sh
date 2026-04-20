#!/bin/bash
# Port post-up hook
# Runs after 'port up' succeeds in a worktree
#
# Available environment variables:
#   PORT_ROOT_PATH     - Absolute path to the main repository root
#   PORT_WORKTREE_PATH - Absolute path to the current worktree
#   PORT_BRANCH        - The branch name (sanitized)
#   PORT_DOMAIN        - Configured domain suffix (for example: port)
#
# Exit non-zero to report a warning. This does not stop services.
#
# Examples:
#   open "http://$PORT_BRANCH.$PORT_DOMAIN:3000"      # macOS
#   xdg-open "http://$PORT_BRANCH.$PORT_DOMAIN:3000"  # Linux

# Uncomment and customize below:
# echo "Opening app for $PORT_BRANCH..."
# open "http://$PORT_BRANCH.$PORT_DOMAIN:3000"
