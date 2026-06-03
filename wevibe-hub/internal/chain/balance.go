package chain

import (
	"context"
	"fmt"

	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
)

func (c *GrpcClient) GetBalance(ctx context.Context, address string) (denom string, amount string, err error) {
	res, err := c.bankQuery.Balance(ctx, &banktypes.QueryBalanceRequest{Address: address, Denom: DefaultFeeDenom})
	if err != nil {
		return DefaultFeeDenom, "", fmt.Errorf("query bank balance: %w", err)
	}

	if res == nil || res.Balance == nil {
		return DefaultFeeDenom, "0", nil
	}

	return DefaultFeeDenom, res.Balance.Amount.String(), nil
}
