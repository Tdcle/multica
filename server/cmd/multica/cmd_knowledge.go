package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

var knowledgeCmd = &cobra.Command{
	Use: "knowledge", Short: "Retrieve knowledge from the workspace's bound space", GroupID: groupCore,
}

var knowledgeSearchCmd = &cobra.Command{
	Use: "search <query>", Short: "Retrieve workspace memories, Skills, Wiki pages and code symbols", Args: exactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		query := strings.TrimSpace(args[0])
		if query == "" || len([]rune(query)) > 2048 {
			return fmt.Errorf("query must contain 1 to 2048 characters")
		}
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		ctx, cancel := cli.APIContext(context.Background())
		defer cancel()
		kind, _ := cmd.Flags().GetString("type")
		var result map[string]any
		if err := client.GetJSON(ctx, "/api/knowledge/retrieve?q="+url.QueryEscape(query)+"&type="+url.QueryEscape(kind), &result); err != nil {
			return fmt.Errorf("search knowledge: %w", err)
		}
		return cli.PrintJSON(os.Stdout, result)
	},
}

var knowledgeListCmd = &cobra.Command{Use: "list", Short: "List accessible knowledge assets and their processing status", Args: exactArgs(0), RunE: func(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result map[string]any
	if err := client.GetJSON(ctx, "/api/knowledge/assets?"+knowledgePageQuery(cmd).Encode(), &result); err != nil {
		return fmt.Errorf("list knowledge: %w", err)
	}
	return cli.PrintJSON(os.Stdout, result)
}}

var knowledgeReadCmd = &cobra.Command{Use: "read <asset-id>", Short: "Read a Skill, Wiki page, memory layer, or explore code symbols", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	values := knowledgePageQuery(cmd)
	for _, flag := range []string{"ref", "query", "layer"} {
		value, _ := cmd.Flags().GetString(flag)
		name := flag
		if flag == "query" {
			name = "q"
		}
		if value != "" {
			values.Set(name, value)
		}
	}
	var result map[string]any
	if err := client.GetJSON(ctx, "/api/knowledge/assets/"+url.PathEscape(args[0])+"?"+values.Encode(), &result); err != nil {
		return fmt.Errorf("read knowledge: %w", err)
	}
	return cli.PrintJSON(os.Stdout, result)
}}

func knowledgePageQuery(cmd *cobra.Command) url.Values {
	offset, _ := cmd.Flags().GetInt("offset")
	limit, _ := cmd.Flags().GetInt("limit")
	return url.Values{"offset": {strconv.Itoa(offset)}, "limit": {strconv.Itoa(limit)}}
}

func init() {
	knowledgeSearchCmd.Flags().String("type", "", "Filter by chat_memory, skill, wiki, or code_graph (default: all)")
	for _, cmd := range []*cobra.Command{knowledgeListCmd, knowledgeReadCmd} {
		cmd.Flags().Int("limit", 100, "Page size (1 to 100)")
		cmd.Flags().Int("offset", 0, "Page offset")
	}
	knowledgeReadCmd.Flags().String("ref", "", "Wiki page reference; omit to list pages")
	knowledgeReadCmd.Flags().String("query", "", "Code symbol or topic to explore; omit to read graph status")
	knowledgeReadCmd.Flags().String("layer", "", "Chat Memory layer: L0, L1, L2 or L3 (default: L1)")
	knowledgeCmd.AddCommand(knowledgeSearchCmd, knowledgeListCmd, knowledgeReadCmd)
	rootCmd.AddCommand(knowledgeCmd)
}
